"""Admin portal: persistent user, teacher and parent management (pack prompt 05)."""
import pytest
from rest_framework.test import APIClient

from apps.accounts.models import AccountStatus, GuardianLink, Role, TeacherAssignment, User
from apps.core.models import AuditEvent

from .conftest import PW, client_for, make_user

pytestmark = pytest.mark.django_db
A = "/api/v1/admin"


def test_every_admin_endpoint_refuses_other_roles(world):
    calls = [("get", f"{A}/users"), ("get", f"{A}/users/counts"), ("get", f"{A}/users/{world.s1.id}"),
             ("patch", f"{A}/users/{world.s1.id}"), ("post", f"{A}/users/{world.s1.id}/status"),
             ("post", f"{A}/users/{world.s1.id}/setup-link"), ("post", f"{A}/teachers/{world.t1.id}/approval"),
             ("post", f"{A}/teacher-assignments"), ("post", f"{A}/guardian-links")]
    for who in (world.s1, world.t1, world.p1):
        c = client_for(who)
        for m, url in calls:
            assert getattr(c, m)(url, {}, format="json").status_code == 403, (who.email, m, url)
    for m, url in calls:
        assert getattr(APIClient(), m)(url, {}, format="json").status_code in (401, 403)


def test_list_search_filter_and_link_ids(world):
    c = client_for(world.admin)
    r = c.get(f"{A}/users", {"role": "student", "q": "s1"}).json()
    assert r["count"] == 1
    u = r["results"][0]
    assert u["teachers"][0]["assignment_id"] == TeacherAssignment.objects.get(student=world.s1).id
    assert u["guardians"][0]["link_id"] == world.link.id and u["has_password"] is True
    t = c.get(f"{A}/users", {"role": "teacher"}).json()["results"]
    assert {x["approved"] for x in t} == {True}
    counts = c.get(f"{A}/users/counts", {"role": "student"}).json()
    assert counts["active"] == 2 and counts["all"] == 2 and counts["unlinked"] == 0


def test_create_student_gives_setup_link_without_email(world, settings):
    c = client_for(world.admin)
    r = c.post(f"{A}/users", {"full_name": "طالب جديد", "email": "New@X.test", "role": "student"}, format="json")
    assert r.status_code == 201
    d = r.json()
    assert d["email"] == "new@x.test" and d["has_password"] is False
    assert d["setup_email_sent"] is False and "/#/reset?uid=" in d["setup_link"]
    assert AuditEvent.objects.filter(action="admin.setup_link_issued").exists()
    # The link works once: set a password, then sign in.
    q = dict(x.split("=", 1) for x in d["setup_link"].split("?", 1)[1].split("&"))
    anon = APIClient()
    assert anon.post("/api/v1/auth/password/reset", {**q, "password": PW}, format="json").status_code == 200
    assert anon.post("/api/v1/auth/password/reset", {**q, "password": PW + "x"}, format="json").status_code == 400
    assert anon.post("/api/v1/auth/login", {"email": "new@x.test", "password": PW}, format="json").status_code == 200
    # Duplicates are refused.
    assert c.post(f"{A}/users", {"full_name": "x y", "email": "new@x.test", "role": "parent"}, format="json").status_code == 400


def test_edit_profile_persists_and_is_audited(world):
    c = client_for(world.admin)
    r = c.patch(f"{A}/users/{world.s1.id}", {"full_name": "يوسف المعدّل", "phone": "+201000000000", "timezone": "Africa/Cairo"}, format="json")
    assert r.status_code == 200 and r.json()["full_name"] == "يوسف المعدّل"
    world.s1.refresh_from_db()
    assert world.s1.full_name == "يوسف المعدّل" and world.s1.phone == "+201000000000"
    assert c.patch(f"{A}/users/{world.s1.id}", {"timezone": "Mars/Base"}, format="json").status_code == 400
    assert c.patch(f"{A}/users/{world.admin.id}", {"full_name": "x y"}, format="json").status_code == 404
    ev = AuditEvent.objects.get(action="admin.user_updated")
    assert ev.data["fields"] == ["full_name", "phone"]


def test_suspend_requires_reason_and_blocks_sign_in_then_reactivate(world):
    c = client_for(world.admin)
    assert c.post(f"{A}/users/{world.s2.id}/status", {"status": "suspended"}, format="json").status_code == 400
    assert c.post(f"{A}/users/{world.s2.id}/status", {"status": "suspended", "reason": "مخالفة"}, format="json").json()["status"] == "suspended"
    assert APIClient().post("/api/v1/auth/login", {"email": "s2@x.test", "password": PW}, format="json").json()["code"] == "account_suspended"
    assert c.post(f"{A}/users/{world.s2.id}/setup-link").status_code == 409
    assert c.post(f"{A}/users/{world.s2.id}/status", {"status": "active"}, format="json").json()["status"] == "active"
    assert APIClient().post("/api/v1/auth/login", {"email": "s2@x.test", "password": PW}, format="json").status_code == 200


def test_teacher_approval_controls_directory(world):
    c = client_for(world.admin)
    student = client_for(world.s1)
    names = lambda: {t["id"] for t in student.get("/api/v1/teachers").json()["results"]}  # noqa: E731
    assert world.t2.id in names()
    assert c.post(f"{A}/teachers/{world.t2.id}/approval", {"approved": False}, format="json").status_code == 400  # reason
    r = c.post(f"{A}/teachers/{world.t2.id}/approval", {"approved": False, "reason": "مراجعة الملف"}, format="json")
    assert r.status_code == 200 and r.json()["approved"] is False
    assert world.t2.id not in names()
    assert c.post(f"{A}/teachers/{world.t2.id}/approval", {}, format="json").json()["approved"] is True
    assert world.t2.id in names()
    assert c.post(f"{A}/teachers/{world.s1.id}/approval", {}, format="json").status_code == 404


def test_assign_and_unassign_teacher_and_parent_links(world):
    c = client_for(world.admin)
    r = c.post(f"{A}/teacher-assignments", {"teacher": world.t2.id, "student": world.s1.id}, format="json")
    assert r.status_code == 201
    assert c.post(f"{A}/teacher-assignments", {"teacher": world.t2.id, "student": world.s1.id}, format="json").status_code == 409
    assert c.post(f"{A}/teacher-assignments", {"teacher": world.s2.id, "student": world.s1.id}, format="json").status_code == 400
    assert c.post(f"{A}/teacher-assignments/{r.json()['id']}/end").status_code == 204
    assert not TeacherAssignment.objects.filter(pk=r.json()["id"], active=True).exists()

    r = c.post(f"{A}/guardian-links", {"guardian": world.p1.id, "student": world.s2.id}, format="json")
    assert r.status_code == 201
    kids = lambda p: {x["id"] for x in client_for(p).get("/api/v1/parent/children").json()["results"]}  # noqa: E731
    assert kids(world.p1) == {world.s1.id, world.s2.id}
    assert c.post(f"{A}/guardian-links", {"guardian": world.s1.id, "student": world.s2.id}, format="json").status_code == 400
    assert c.post(f"{A}/guardian-links/{r.json()['id']}/revoke", {"reason": "طلب الأسرة"}, format="json").status_code == 204
    assert kids(world.p1) == {world.s1.id}
    assert GuardianLink.objects.get(pk=r.json()["id"]).status == "revoked"


def test_teacher_invitation_link_creates_approved_teacher(world):
    c = client_for(world.admin)
    r = c.post("/api/v1/invitations", {"purpose": "teacher_account", "email": "newt@x.test"}, format="json").json()
    assert "/#/invite?code=" in r["link"]
    anon = APIClient()
    acc = anon.post("/api/v1/auth/invitations/accept", {"code": r["code"], "full_name": "معلم جديد", "email": "newt@x.test", "password": PW}, format="json")
    assert acc.status_code == 201
    t = User.objects.get(email="newt@x.test")
    assert t.role == Role.TEACHER and t.status == AccountStatus.ACTIVE and t.teacher_profile.approved_at is not None
    assert anon.post("/api/v1/auth/invitations/accept", {"code": r["code"], "full_name": "x y", "email": "o@x.test", "password": PW}, format="json").status_code == 400


def test_parent_children_not_leaked_to_other_parent(world):
    p2 = make_user("p2@x.test", Role.PARENT)
    assert client_for(p2).get("/api/v1/parent/children").json()["results"] == []
