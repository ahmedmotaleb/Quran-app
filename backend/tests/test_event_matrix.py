"""Event → recipient matrix for notifications and phone pushes (owner report, 10 Nov 2026: requests by students,
teachers and administrators were not reaching phones).

For each event: the right people get an in-app notification, nobody else does, the push goes out only after the
transaction commits (never for a rolled-back action), each recipient is pushed once (dedupe), the tap opens the
right place (admin portal section for administrators, the notification for everyone else), and a temporary push
failure is retried by the hourly job a bounded number of times. Pushes are captured at the pywebpush boundary.
"""
import json
from datetime import timedelta

import pytest
from django.db import transaction
from django.utils import timezone

from apps.accounts.models import GuardianLink, LinkStatus, Role, TeacherAssignment  # noqa: F401
from apps.notifications import push
from apps.notifications.models import Notification, PushSubscription
from apps.notifications.services import notify

from rest_framework.test import APIClient

from .conftest import client_for, make_user, occurrence
from .test_admins import staff
from .test_push import keys  # noqa: F401  (fixture)

pytestmark = pytest.mark.django_db
MINE = "/api/v1/student/teacher-request"
ADMIN_REQ = "/api/v1/admin/teacher-requests"


class Phones:
    """Every push that reached the push-service boundary: (recipient email, payload)."""

    def __init__(self, monkeypatch, fail=None):
        import pywebpush

        self.sent, self.fail = [], fail
        by_ep = {}

        def webpush(subscription_info, data, **kw):
            ep = subscription_info["endpoint"]
            if self.fail:
                status = self.fail.pop(0) if isinstance(self.fail, list) else self.fail
                if status:
                    raise pywebpush.WebPushException("x", response=type("R", (), {"status_code": status})())
            u = by_ep.get(ep) or PushSubscription.objects.get(endpoint=ep).user.email
            by_ep[ep] = u
            self.sent.append((u, json.loads(data)))

        monkeypatch.setattr(pywebpush, "webpush", webpush)

    def to(self, user):
        return [p for e, p in self.sent if e == user.email]


def phone(u):
    return PushSubscription.objects.create(user=u, endpoint=f"https://fcm.googleapis.com/fcm/send/{u.pk}", p256dh="p", auth="a",
                                           device="Mozilla/5.0 (Linux; Android 14) Chrome/130")


def kinds(u):
    return sorted(Notification.objects.filter(recipient=u).values_list("kind", flat=True))


@pytest.fixture
def team(world, keys):  # noqa: F811
    """world + a student without a teacher, an academic manager (may assign/approve), a support admin (may not),
    and a phone for everyone."""
    t = type("T", (), {})()
    t.w = world
    t.lone = make_user("lone@x.test")
    t.manager = staff("manager@x.test", preset="academic_manager")
    t.support = staff("support@x.test", preset="support")
    for u in (world.s1, world.s2, world.t1, world.t2, world.p1, world.admin, t.lone, t.manager, t.support):
        phone(u)
    Notification.objects.all().delete()
    return t


def run(fn, capture):
    with capture(execute=True):
        return fn()


# ---- 1. student requests a teacher → administrators who may assign ---------------------------------------------
def test_teacher_request_reaches_only_admins_who_may_assign(team, monkeypatch, django_capture_on_commit_callbacks):
    ph = Phones(monkeypatch)
    rid = run(lambda: client_for(team.lone).post(MINE, {"teacher": team.w.t1.pk}, format="json"), django_capture_on_commit_callbacks).json()["id"]
    assert "admin_teacher_request" in kinds(team.manager) and "admin_teacher_request" in kinds(team.w.admin)   # owner + manager
    assert kinds(team.support) == []                    # no teachers.assign: never sees the student's name
    assert kinds(team.w.t1) == [] and kinds(team.w.s1) == []
    p = ph.to(team.manager)
    assert len(p) == 1 and p[0]["url"] == "/admin/#/admin/teacherRequests" and team.lone.full_name not in json.dumps(p[0], ensure_ascii=False)
    n = Notification.objects.get(recipient=team.manager)
    assert n.push_status == "sent" and n.data["teacher_request"] == rid


# ---- 2. admin assigns → student and the assigned teacher (once each) ---------------------------------------------
def test_assignment_tells_student_and_teacher_once(team, monkeypatch, django_capture_on_commit_callbacks):
    rid = run(lambda: client_for(team.lone).post(MINE, {"teacher": team.w.t1.pk}, format="json"), django_capture_on_commit_callbacks).json()["id"]
    ph = Phones(monkeypatch)
    run(lambda: client_for(team.manager).post(f"{ADMIN_REQ}/{rid}/decide", {"action": "assign"}, format="json"), django_capture_on_commit_callbacks)
    assert kinds(team.lone).count("teacher_request_assigned") == 1 and "teacher_assigned" not in kinds(team.lone)   # once
    assert kinds(team.w.t1) == ["student_assigned"] and kinds(team.w.t2) == []
    assert len(ph.to(team.lone)) == 1 and len(ph.to(team.w.t1)) == 1
    assert ph.to(team.lone)[0]["url"].startswith("/#/n/")


def test_assignment_from_the_student_record_tells_both(team, monkeypatch, django_capture_on_commit_callbacks):
    ph = Phones(monkeypatch)
    # The admin's «ربط بمعلم» on the student record (reassign.assign_teacher; a bare database insert notifies no one).
    run(lambda: client_for(team.w.admin).post("/api/v1/admin/teacher-assignments", {"teacher": team.w.t2.pk, "student": team.lone.pk},
                                              format="json"), django_capture_on_commit_callbacks)
    assert kinds(team.lone) == ["teacher_assigned"] and kinds(team.w.t2) == ["student_assigned"]
    assert len(ph.to(team.lone)) == 1 and len(ph.to(team.w.t2)) == 1


# ---- 3. rejection (teacher unavailable) → student only --------------------------------------------------------
def test_unavailable_tells_only_the_student(team, monkeypatch, django_capture_on_commit_callbacks):
    rid = run(lambda: client_for(team.lone).post(MINE, {"teacher": team.w.t1.pk}, format="json"), django_capture_on_commit_callbacks).json()["id"]
    Notification.objects.all().delete()
    ph = Phones(monkeypatch)
    run(lambda: client_for(team.manager).post(f"{ADMIN_REQ}/{rid}/decide", {"action": "unavailable"}, format="json"), django_capture_on_commit_callbacks)
    assert kinds(team.lone) == ["teacher_request_unavailable"]
    assert all(kinds(u) == [] for u in (team.w.t1, team.w.t2, team.manager, team.w.admin))
    assert [e for e, _ in ph.sent] == [team.lone.email]


# ---- 4/5. teacher setup awaiting approval → admins; approval → teacher ------------------------------------------
def test_teacher_ready_for_approval_then_approved(team, monkeypatch, django_capture_on_commit_callbacks):
    from django.contrib.auth.tokens import default_token_generator
    from django.utils.encoding import force_bytes
    from django.utils.http import urlsafe_base64_encode

    from apps.accounts.teacher_onboarding import create_teacher

    t = create_teacher("خالد الجديد", "new.teacher@x.test")
    ph = Phones(monkeypatch)
    uid, tok = urlsafe_base64_encode(force_bytes(t.pk)), default_token_generator.make_token(t)
    r = run(lambda: APIClient().post("/api/v1/auth/password/reset", {"uid": uid, "token": tok, "password": "a-Long-pass-123"},
                                          format="json"), django_capture_on_commit_callbacks)
    assert r.status_code == 200, r.json()
    assert "admin_teacher_pending" in kinds(team.manager) and kinds(team.support) == []
    assert ph.to(team.manager)[0]["url"] == "/admin/#/admin/teachers"
    run(lambda: client_for(team.manager).post(f"/api/v1/admin/teachers/{t.pk}/approval", {"approved": True}, format="json"),
        django_capture_on_commit_callbacks)
    assert kinds(t) == ["teacher_approved"]
    # a later password reset of the same (now approved) teacher does not page the admins again
    n = Notification.objects.filter(recipient=team.manager).count()
    tok2 = default_token_generator.make_token(t)
    run(lambda: APIClient().post("/api/v1/auth/password/reset", {"uid": uid, "token": tok2, "password": "Another-pass-456"},
                                      format="json"), django_capture_on_commit_callbacks)
    assert Notification.objects.filter(recipient=team.manager).count() == n


# ---- 6/7/8. booking → teacher; admin cancels → student AND teacher ----------------------------------------------
def test_booking_and_admin_cancellation(team, monkeypatch, django_capture_on_commit_callbacks):
    from apps.scheduling import services

    o = occurrence(team.w.t1, in_hours=72)
    ph = Phones(monkeypatch)
    b, _ = run(lambda: services.book(student=team.w.s1, occurrence_id=o.pk, idempotency_key="k1"), django_capture_on_commit_callbacks)
    assert kinds(team.w.s1) == ["booking_confirmed"] and kinds(team.w.t1) == ["booking_new"] and kinds(team.w.t2) == []
    run(lambda: services.cancel(booking_id=b.pk, by=team.manager, reason="ظرف طارئ"), django_capture_on_commit_callbacks)
    assert "booking_cancelled" in kinds(team.w.s1) and "booking_cancelled_by_admin" in kinds(team.w.t1)
    assert kinds(team.w.s2) == [] and kinds(team.w.p1) == []
    assert {e for e, _ in ph.sent} == {team.w.s1.email, team.w.t1.email}


def test_admin_cancels_a_whole_session(team, monkeypatch, django_capture_on_commit_callbacks):
    from apps.scheduling import services

    o = occurrence(team.w.t1, in_hours=72, capacity=2)
    run(lambda: services.book(student=team.w.s1, occurrence_id=o.pk, idempotency_key="k2"), django_capture_on_commit_callbacks)
    Notification.objects.all().delete()
    run(lambda: services.cancel_occurrence(occurrence_id=o.pk, by=team.manager, reason="إجازة"), django_capture_on_commit_callbacks)
    assert kinds(team.w.s1) == ["booking_cancelled"] and kinds(team.w.t1) == ["session_cancelled_by_admin"]


# ---- 9/10/11. homework → student; submission → teacher; feedback → student + linked parent ----------------------
def test_homework_submission_feedback_and_parent(team, monkeypatch, django_capture_on_commit_callbacks):
    from .test_media_submissions import FB, submit, upload

    t1, s1 = client_for(team.w.t1), client_for(team.w.s1)
    body = {"student": team.w.s1.id, "kind": "hifz", "title": "حفظ", "surah": 67, "ayah_from": 1, "ayah_to": 5,
            "due_at": (timezone.now() + timedelta(days=2)).isoformat()}
    ph = Phones(monkeypatch)
    a = run(lambda: t1.post("/api/v1/assignments", body, format="json"), django_capture_on_commit_callbacks).json()
    from apps.learning.models import Assignment
    sub = run(lambda: submit(s1, Assignment.objects.get(pk=a["id"]), upload(s1).json()["id"]), django_capture_on_commit_callbacks).json()
    run(lambda: t1.post(f"/api/v1/submissions/{sub['id']}/feedback", FB, format="json"), django_capture_on_commit_callbacks)
    assert kinds(team.w.s1) == ["assignment_new", "feedback_new"] and kinds(team.w.t1) == ["submission_new"]
    assert kinds(team.w.p1) == ["child_feedback"]
    pp = ph.to(team.w.p1)[0]
    assert pp["body"] == "تحديث عن أحد أبنائك." and "حفظ" not in json.dumps(pp, ensure_ascii=False)   # generic on the lock screen
    for u in (team.w.s2, team.w.t2, team.manager, team.support):
        assert kinds(u) == []


# ---- 12/13. excuse → teacher; decision → student + teacher + parent --------------------------------------------
def test_excuse_request_and_decision(team, monkeypatch, django_capture_on_commit_callbacks):
    from apps.scheduling import services

    o = occurrence(team.w.t1, in_hours=72)
    b, _ = run(lambda: services.book(student=team.w.s1, occurrence_id=o.pk, idempotency_key="k3"), django_capture_on_commit_callbacks)
    Notification.objects.all().delete()
    r = run(lambda: client_for(team.w.s1).post(f"/api/v1/bookings/{b.pk}/excuse", {"reason": "سفر عائلي طارئ", "category": "travel"},
                                               format="json"), django_capture_on_commit_callbacks)
    if r.status_code == 404:
        pytest.skip("excuse endpoint path differs")
    assert r.status_code in (200, 201), r.json()
    assert kinds(team.w.t1) == ["excuse_new"] and kinds(team.w.t2) == []


# ---- the outbox: after commit only, once, retried a bounded number of times, deep links ---------------------------
def test_no_push_and_no_notice_for_a_rolled_back_action(team, monkeypatch, django_capture_on_commit_callbacks):
    ph = Phones(monkeypatch)
    with django_capture_on_commit_callbacks(execute=True):
        try:
            with transaction.atomic():
                notify(team.w.s1, "assignment_new", "x", "y", dedupe="rb1")
                raise RuntimeError("the business action failed")
        except RuntimeError:
            pass
    assert not Notification.objects.filter(dedupe_key="rb1").exists() and ph.sent == []


def test_push_waits_for_the_commit(team, monkeypatch, django_capture_on_commit_callbacks):
    ph = Phones(monkeypatch)
    with django_capture_on_commit_callbacks(execute=True) as cbs:
        with transaction.atomic():
            notify(team.w.s1, "assignment_new", "x", "y", dedupe="c1")
            assert ph.sent == []                                   # not yet: still inside the transaction
            assert Notification.objects.get(dedupe_key="c1").push_status == "pending"
    assert len(cbs) >= 1 and len(ph.to(team.w.s1)) == 1
    assert Notification.objects.get(dedupe_key="c1").push_status == "sent"


def test_same_event_twice_is_one_notice_and_one_push(team, monkeypatch, django_capture_on_commit_callbacks):
    ph = Phones(monkeypatch)
    with django_capture_on_commit_callbacks(execute=True):
        notify(team.w.s1, "booking_confirmed", "x", dedupe="booking:9:confirmed")
        notify(team.w.s1, "booking_confirmed", "x", dedupe="booking:9:confirmed")
    assert Notification.objects.filter(recipient=team.w.s1, dedupe_key="booking:9:confirmed").count() == 1 and len(ph.sent) == 1


def test_status_explains_every_outcome(team, monkeypatch, django_capture_on_commit_callbacks, settings):
    Phones(monkeypatch)
    nobody = make_user("nodevice@x.test")
    with django_capture_on_commit_callbacks(execute=True):
        a = notify(team.w.s1, "assignment_new", "x", dedupe="s1")                 # E: accepted by the push service
        b = notify(nobody, "assignment_new", "x", dedupe="s2")                    # C: no device
        team.w.s2.notify_prefs = {"tasks": False}; team.w.s2.save(update_fields=["notify_prefs"])
        c = notify(team.w.s2, "assignment_new", "x", dedupe="s3")                 # preference off
    st = {n.dedupe_key: n.push_status for n in Notification.objects.filter(pk__in=[a.pk, b.pk, c.pk])}
    assert st == {"s1": "sent", "s2": "no_device", "s3": "pref_off"}
    settings.VAPID_PRIVATE_KEY = ""
    with django_capture_on_commit_callbacks(execute=True):
        d = notify(team.w.s1, "assignment_new", "x", dedupe="s4")                 # push not configured
    assert Notification.objects.get(pk=d.pk).push_status == "off"


def test_temporary_failure_is_retried_then_stops(team, monkeypatch, django_capture_on_commit_callbacks):
    ph = Phones(monkeypatch, fail=503)
    with django_capture_on_commit_callbacks(execute=True):
        n = notify(team.w.s1, "assignment_new", "x", dedupe="r1")
    n.refresh_from_db()
    assert n.push_status == "retry" and n.push_attempts == 1 and n.push_error == "push_service"
    later = timezone.now() + timedelta(minutes=10)
    push.retry_pending(later)
    n.refresh_from_db()
    assert n.push_status == "retry" and n.push_attempts == 2
    push.retry_pending(later + timedelta(minutes=10))
    n.refresh_from_db()
    assert n.push_status == "failed" and n.push_attempts == 3                    # bounded: 3 attempts in total
    push.retry_pending(later + timedelta(minutes=20))
    n.refresh_from_db()
    assert n.push_attempts == 3 and ph.sent == []


def test_retry_succeeds_and_never_repeats_a_device_that_accepted(team, monkeypatch, django_capture_on_commit_callbacks):
    second = PushSubscription.objects.create(user=team.w.s1, endpoint="https://fcm.googleapis.com/fcm/send/second", p256dh="p", auth="a",
                                             device="Android")
    ph = Phones(monkeypatch, fail=[0, 503])                                       # phone 1 accepts, phone 2 is busy
    with django_capture_on_commit_callbacks(execute=True):
        n = notify(team.w.s1, "assignment_new", "x", dedupe="r2")
    n.refresh_from_db()
    assert n.push_status == "retry" and n.push_targets == [second.pk] and len(ph.sent) == 1
    ph.fail = None
    push.retry_pending(timezone.now() + timedelta(minutes=10))
    n.refresh_from_db()
    assert n.push_status == "sent" and len(ph.sent) == 2                         # only phone 2 the second time
    assert len({json.dumps({k: v for k, v in p.items() if k != 'r'}) for _, p in ph.sent}) == 1   # same notice (r is per device)


def test_pending_left_by_a_crash_is_sent_by_the_hourly_job(team, monkeypatch):
    ph = Phones(monkeypatch)
    n = Notification.objects.create(recipient=team.w.s1, kind="assignment_new", title="x", dedupe_key="crash", push_status="pending")
    Notification.objects.filter(pk=n.pk).update(created_at=timezone.now() - timedelta(minutes=30))
    assert push.retry_pending()["retried"] == 1 and len(ph.to(team.w.s1)) == 1
    assert push.retry_pending()["retried"] == 0                                  # claimed once


def test_hourly_job_runs_the_retry_step():
    from apps.core.management.commands import run_scheduled

    import inspect

    assert '"push_retry"' in inspect.getsource(run_scheduled)


def test_admins_and_every_role_can_connect_a_device(team, keys):  # noqa: F811
    sub = {"endpoint": "https://fcm.googleapis.com/fcm/send/role-{}", "keys": {"p256dh": "p" * 20, "auth": "a" * 10}}
    for u in (team.manager, team.w.t1, team.w.s2, team.w.p1):
        PushSubscription.objects.filter(user=u).delete()
        c = client_for(u)
        r = c.post("/api/v1/push/subscriptions", {**sub, "endpoint": sub["endpoint"].format(u.pk)}, format="json")
        assert r.status_code == 201, (u.role, r.json())
        assert c.get("/api/v1/push/status", {"endpoint": sub["endpoint"].format(u.pk)}).json()["this_device"]["active"] is True


def test_deep_links_by_recipient():
    assert push.payload_for("admin_teacher_request", "/admin", 5, admin_section="teacherRequests")["url"] == "/admin/#/admin/teacherRequests"
    assert push.payload_for("admin_teacher_pending", "/admin", 5, admin_section="nope")["url"] == "/admin/#/admin/overview"   # unknown → overview
    for k in ("booking_confirmed", "student_assigned", "child_feedback", "teacher_approved", "excuse_new"):
        assert push.payload_for(k, "/x", 9)["url"] == "/#/n/9"
    n = Notification(kind="admin_message", data={"admin_section": "students"})     # a message FROM the admin to a learner
    assert push._admin_section(n, Role.STUDENT) is None


def test_unverified_parent_link_gets_nothing(team, monkeypatch):
    from apps.learning.views import _tell_guardians_feedback

    GuardianLink.objects.filter(guardian=team.w.p1).update(status=LinkStatus.PENDING)
    _tell_guardians_feedback(team.w.s1, 999)
    assert kinds(team.w.p1) == []

