"""Student → Teacher promotion (owner decision 23 October 2026): one account at a time, same id/email/password/history;
learner-only relationships end; not approved unless asked; every device signed out. Also: invitations never convert
an account, and people search matches phone numbers in any format."""
from datetime import timedelta

import pytest
from django.contrib.sessions.models import Session
from django.core import mail
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import AuthToken, GuardianLink, LinkStatus, Role, TeacherAssignment, User
from apps.core.models import AuditEvent
from apps.learning.models import Assignment, AssignmentStatus, Course, Enrollment, Feedback, Submission
from apps.media.models import MediaObject
from apps.scheduling.models import Booking, Circle, CircleMember

from .conftest import PW, client_for, make_user, occurrence

pytestmark = pytest.mark.django_db


def promote(admin, pk, **body):
    data = {"reason": "أصبح معلمًا في الحلقة", "confirm": "ترقية", **body}
    return client_for(admin).post(f"/api/v1/admin/users/{pk}/promote-teacher", data, format="json")


def student_with_history(w):
    s = w.s1
    a = Assignment.objects.create(student=s, teacher=w.t1, kind="hifz", title="حفظ", surah=67, ayah_from=1, ayah_to=5,
                                  due_at=timezone.now() + timedelta(days=1), status=AssignmentStatus.SUBMITTED)
    open_task = Assignment.objects.create(student=s, teacher=w.t1, kind="hifz", title="حفظ آخر", surah=67, ayah_from=6, ayah_to=10,
                                          due_at=timezone.now() + timedelta(days=2))
    m = MediaObject.objects.create(owner=s, purpose="recitation", key=f"rec/p{a.pk}.webm", content_type="audio/webm", state="validated")
    sub = Submission.objects.create(assignment=a, student=s, media=m, attempt=1, duration_seconds=30, idempotency_key="p1")
    Feedback.objects.create(submission=sub, teacher=w.t1, score_hifz=4, score_tajweed=4, score_fluency=4, decision="accept")
    past = occurrence(w.t2, in_hours=-48, capacity=3)
    Booking.objects.create(occurrence=past, student=s, idempotency_key="b-past", attendance="present")
    future = occurrence(w.t2, in_hours=48, capacity=3)
    Booking.objects.create(occurrence=future, student=s, idempotency_key="b-future")
    circle = Circle.objects.create(name="حلقة", teacher=w.t2, capacity=5, state="published")
    CircleMember.objects.create(circle=circle, student=s)
    Enrollment.objects.create(course=Course.objects.create(title="دورة", teacher=w.t1), student=s)
    return a, open_task, sub


def test_promotion_keeps_the_account_and_history_and_ends_learner_links(world):
    s = world.s1
    a, open_task, sub = student_with_history(world)
    old_token = client_for(s)
    web = APIClient()
    assert web.post("/api/v1/auth/login", {"email": s.email, "password": PW}, format="json").status_code == 200
    assert Session.objects.count() >= 1
    r = promote(world.admin, s.pk)
    assert r.status_code == 200, r.json()
    d = r.json()
    assert d["approved"] is False and d["assignments_ended"] == 1 and d["bookings_cancelled"] == 1
    assert d["memberships_ended"] == 1 and d["guardian_links_revoked"] == 1 and d["enrollments_withdrawn"] == 1
    u = User.objects.get(pk=s.pk)
    assert u.role == Role.TEACHER and u.email == "s1@x.test" and u.check_password(PW)   # same identity
    assert u.teacher_profile.approved_at is None and u.teacher_profile.bio == ""
    assert hasattr(u, "student_profile")                                              # kept as history
    # History stays on the same user id.
    assert Submission.objects.filter(pk=sub.pk, student=u).exists() and Feedback.objects.filter(submission=sub).exists()
    assert Booking.objects.get(student=u, idempotency_key="b-past").attendance == "present"
    assert Assignment.objects.filter(pk=open_task.pk, student=u).exists()
    # Learner-only relationships ended.
    assert not TeacherAssignment.objects.filter(student=u, active=True).exists()
    b = Booking.objects.get(student=u, idempotency_key="b-future")
    assert b.status == "cancelled" and b.cancel_reason == "تمت ترقية الحساب إلى معلم"
    assert not CircleMember.objects.filter(student=u, active=True).exists()
    assert GuardianLink.objects.get(pk=world.link.pk).status == LinkStatus.REVOKED
    assert Enrollment.objects.get(student=u).status == "withdrawn"
    # Every device signed out; the next sign-in is a teacher.
    assert old_token.get("/api/v1/me").status_code == 401 and not AuthToken.objects.filter(user=u, revoked_at__isnull=True).exists()
    assert web.get("/api/v1/me").status_code in (401, 403)
    fresh = APIClient()
    me = fresh.post("/api/v1/auth/login", {"email": "s1@x.test", "password": PW, "client": "native"}, format="json").json()
    assert me["user"]["role"] == "teacher"
    t = client_for(u)
    assert t.get("/api/v1/teacher/students").status_code == 200       # teacher API works
    assert t.put("/api/v1/me/onboarding", {"level": "x"}, format="json").status_code == 403  # student-only API refused
    ev = AuditEvent.objects.get(action="admin.user_promoted_to_teacher")
    assert ev.data["old_role"] == "student" and ev.data["new_role"] == "teacher" and ev.data["reason"] == "أصبح معلمًا في الحلقة"
    assert ev.data["approved"] is False and ev.data["bookings_cancelled"] == 1 and ev.actor == world.admin


def test_promotion_can_approve_and_emails_without_password(world, settings):
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    from apps.accounts import emails

    real = emails.email_configured
    emails.email_configured = lambda: True
    try:
        r = promote(world.admin, world.s2.pk, approve=True)
    finally:
        emails.email_configured = real
    assert r.json()["approved"] is True and r.json()["emailed"] is True
    assert User.objects.get(pk=world.s2.pk).teacher_profile.approved_at is not None
    m = mail.outbox[-1]
    assert m.subject == "تم تحديث حسابك في حَلْقة" and "بنفس البريد وكلمة المرور" in m.body and PW not in m.body


def test_invalid_promotions_are_refused(world):
    other_admin = make_user("admin2@x.test", Role.ADMIN)
    assert promote(world.admin, world.t1.pk).json()["code"] == "not_student"
    assert promote(world.admin, world.p1.pk).json()["code"] == "not_student"
    assert promote(world.admin, other_admin.pk).status_code == 404
    gone = make_user("gone@x.test")
    gone.status = "deleted"
    gone.save()
    assert promote(world.admin, gone.pk).json()["code"] == "deleted"
    arch = make_user("arch@x.test")
    arch.status = "archived"
    arch.save()
    assert promote(world.admin, arch.pk).json()["code"] == "archived"
    assert promote(world.admin, world.s2.pk, reason="").status_code == 400
    assert promote(world.admin, world.s2.pk, confirm="نعم").json()["code"] == "confirm_required"
    for u in (world.t1, world.s1, world.p1):
        assert client_for(u).post(f"/api/v1/admin/users/{world.s2.pk}/promote-teacher",
                                  {"reason": "سبب كاف", "confirm": "ترقية"}, format="json").status_code == 403
    assert User.objects.get(pk=world.s2.pk).role == Role.STUDENT and User.objects.get(pk=arch.pk).role == Role.STUDENT


def test_no_generic_role_change_and_no_bulk_promotion(world):
    c = client_for(world.admin)
    c.patch(f"/api/v1/admin/users/{world.s1.pk}", {"role": "teacher", "full_name": "اسم"}, format="json")
    assert User.objects.get(pk=world.s1.pk).role == Role.STUDENT
    r = c.post("/api/v1/admin/users/bulk-action", {"action": "make_teacher", "ids": [world.s1.pk], "reason": "سبب"}, format="json")
    assert r.status_code == 400 and r.json()["code"] == "invalid_action"


def test_teacher_invitation_never_converts_an_account(world):
    def invite(email):
        return client_for(world.admin).post("/api/v1/invitations", {"purpose": "teacher_account", "email": email}, format="json")

    r = invite("S1@X.test")  # any case
    assert r.status_code == 409 and r.json()["code"] == "existing_student"
    assert r.json()["fields"] == {"user": [str(world.s1.pk)], "role": ["student"]} and "لم تُرسل أي دعوة" in r.json()["message"]
    p = invite("p1@x.test").json()
    assert p["code"] == "email_taken" and "ولي أمر" in p["message"]
    assert invite("admin@x.test").json()["code"] == "email_is_admin"
    assert invite("t1@x.test").json()["code"] == "email_taken"
    assert User.objects.get(pk=world.s1.pk).role == Role.STUDENT and User.objects.get(pk=world.p1.pk).role == Role.PARENT
    from apps.accounts.models import Invitation

    assert not Invitation.objects.exists()


def test_people_search_by_phone_in_any_format(world):
    world.p1.phone = "+20 100 123 4567"
    world.p1.save()
    c = client_for(world.admin)
    for q in ("01001234567", "0100-123-4567", "+201001234567", "1001234567"):
        ids = [u["id"] for u in c.get("/api/v1/admin/users", {"role": "parent", "q": q}).json()["results"]]
        assert ids == [world.p1.pk], q
    assert c.get("/api/v1/admin/users", {"role": "parent", "q": "01009999999"}).json()["results"] == []


def test_promoted_teacher_does_not_show_student_profile_details(world):
    from apps.accounts.models import StudentProfile

    StudentProfile.objects.filter(user=world.s1).update(level="متوسط", daily_goal="5 أسطر")
    promote(world.admin, world.s1.pk)
    u = User.objects.get(pk=world.s1.pk)
    me = client_for(u).get("/api/v1/me").json()
    assert me["role"] == "teacher" and me["level"] == "" and me["daily_goal"] == ""
    assert client_for(world.admin).get(f"/api/v1/admin/users/{u.pk}").json()["level"] == ""
    assert u.student_profile.level == "متوسط"  # still stored, as history
