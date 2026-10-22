"""Owner report 22 October 2026: an email already registered as a student (or admin) could not be made a teacher.
One account has one role, so the admin converts a student/parent account into a teacher; admins are refused."""
import pytest

from apps.accounts.models import AuthToken, GuardianLink, LinkStatus, Role, TeacherAssignment, User
from apps.core.models import AuditEvent
from apps.scheduling.models import Booking

from .conftest import PW, client_for, make_user, occurrence

pytestmark = pytest.mark.django_db
BULK = "/api/v1/admin/users/bulk-action"


def invite(admin, email):
    return client_for(admin).post("/api/v1/invitations", {"purpose": "teacher_account", "email": email}, format="json")


def test_invite_explains_existing_student_and_admin_emails(world):
    r = invite(world.admin, "s1@x.test")
    assert r.status_code == 409 and r.json()["code"] == "existing_learner"
    assert r.json()["fields"] == {"user": [str(world.s1.pk)], "role": ["student"]} and "طالب" in r.json()["message"]
    assert invite(world.admin, "p1@x.test").json()["code"] == "existing_learner"
    a = invite(world.admin, "admin@x.test").json()
    assert a["code"] == "email_is_admin"
    assert invite(world.admin, "t1@x.test").json()["code"] == "email_taken"


def test_convert_student_to_teacher(world):
    o = occurrence(world.t2, capacity=3)
    Booking.objects.create(occurrence=o, student=world.s1, idempotency_key="k1")
    native = client_for(world.s1)
    r = client_for(world.admin).post(BULK, {"action": "make_teacher", "ids": [world.s1.pk], "reason": "أصبح معلمًا"}, format="json")
    assert r.json()["success"] == 1, r.json()
    u = User.objects.get(pk=world.s1.pk)
    assert u.role == Role.TEACHER and u.teacher_profile.approved_at is not None
    assert not TeacherAssignment.objects.filter(student=u, active=True).exists()
    assert GuardianLink.objects.get(pk=world.link.pk).status == LinkStatus.REVOKED
    assert Booking.objects.get(student=u).status == Booking.Status.CANCELLED
    assert native.get("/api/v1/me").status_code == 401 and not AuthToken.objects.filter(user=u, revoked_at__isnull=True).exists()
    from rest_framework.test import APIClient

    me = APIClient().post("/api/v1/auth/login", {"email": "s1@x.test", "password": PW, "client": "native"}, format="json").json()
    assert me["user"]["role"] == "teacher"  # same password, now a teacher
    ev = AuditEvent.objects.get(action="admin.role_changed")
    assert ev.data == {"old": "student", "new": "teacher"}


def test_conversion_rules(world):
    c = client_for(world.admin)
    assert c.post(BULK, {"action": "make_teacher", "ids": [world.s1.pk]}, format="json").status_code == 400  # reason
    r = c.post(BULK, {"action": "make_teacher", "ids": [world.t1.pk], "reason": "سبب"}, format="json").json()
    assert r["skipped"] == 1
    other = make_user("admin2@x.test", Role.ADMIN)
    assert c.post(BULK, {"action": "make_teacher", "ids": [other.pk], "reason": "سبب"}, format="json").json()["success"] == 0
    assert User.objects.get(pk=other.pk).role == Role.ADMIN
    assert client_for(world.t1).post(BULK, {"action": "make_teacher", "ids": [world.s2.pk], "reason": "سبب"}, format="json").status_code == 403


def test_people_search_by_phone_in_any_format(world):
    world.p1.phone = "+20 100 123 4567"
    world.p1.save()
    c = client_for(world.admin)
    for q in ("01001234567", "0100-123-4567", "+201001234567", "1001234567"):
        ids = [u["id"] for u in c.get("/api/v1/admin/users", {"role": "parent", "q": q}).json()["results"]]
        assert ids == [world.p1.pk], q
    assert c.get("/api/v1/admin/users", {"role": "parent", "q": "01009999999"}).json()["results"] == []
    assert [u["id"] for u in c.get("/api/v1/admin/users", {"role": "parent", "q": "p1@x"}).json()["results"]] == [world.p1.pk]
