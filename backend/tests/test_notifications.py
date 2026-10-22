"""Pack prompt 17: every key event notifies the right person once; others get nothing; retries don't duplicate."""
from datetime import timedelta

import pytest
from django.core.management import call_command
from django.utils import timezone

from apps.notifications.models import Notification

from .conftest import client_for, occurrence
from .test_media_submissions import FB, _private_root, submit, upload  # noqa: F401
from .test_progress import task

pytestmark = pytest.mark.django_db


def kinds(u):
    return list(Notification.objects.filter(recipient=u).values_list("kind", flat=True))


@pytest.fixture
def run_commits(django_capture_on_commit_callbacks):
    def _run(fn):
        with django_capture_on_commit_callbacks(execute=True):
            return fn()
    return _run


def test_assignment_submission_feedback_chain(world, run_commits):
    t1, s1 = client_for(world.t1), client_for(world.s1)
    body = {"student": world.s1.id, "kind": "hifz", "title": "حفظ الملك", "surah": 67, "ayah_from": 1, "ayah_to": 5,
            "due_at": (timezone.now() + timedelta(days=2)).isoformat()}
    a = run_commits(lambda: t1.post("/api/v1/assignments", body, format="json")).json()
    assert kinds(world.s1) == ["assignment_new"]
    n = Notification.objects.get(recipient=world.s1)
    assert n.data == {"assignment": a["id"]} and "http" not in str(n.data)
    from apps.learning.models import Assignment
    task_ = Assignment.objects.get(pk=a["id"])
    sub = run_commits(lambda: submit(s1, task_, upload(s1).json()["id"])).json()
    assert kinds(world.t1) == ["submission_new"]
    run_commits(lambda: t1.post(f"/api/v1/submissions/{sub['id']}/feedback", FB, format="json"))
    assert sorted(kinds(world.s1)) == ["assignment_new", "feedback_new"]
    # Unrelated people get nothing.
    for u in (world.s2, world.t2, world.p1, world.admin):
        assert kinds(u) == []


def test_booking_events(world, run_commits):
    o1, o2 = occurrence(world.t1, in_hours=48), occurrence(world.t1, in_hours=72)
    s1 = client_for(world.s1)
    b = run_commits(lambda: s1.post("/api/v1/bookings", {"occurrence": o1.id}, format="json", HTTP_IDEMPOTENCY_KEY="a")).json()
    run_commits(lambda: s1.post("/api/v1/bookings", {"occurrence": o1.id}, format="json", HTTP_IDEMPOTENCY_KEY="a"))  # retry
    assert kinds(world.s1) == ["booking_confirmed"] and kinds(world.t1) == ["booking_new"]
    r = run_commits(lambda: s1.post(f"/api/v1/bookings/{b['id']}/reschedule", {"occurrence": o2.id}, format="json", HTTP_IDEMPOTENCY_KEY="b"))
    assert r.status_code in (200, 201), r.json()
    assert "booking_rescheduled" in kinds(world.t1) and kinds(world.s1).count("booking_cancelled") == 0
    new_id = r.json()["id"]
    # Students no longer cancel; an excuse request reaches the teacher instead.
    run_commits(lambda: s1.post(f"/api/v1/bookings/{new_id}/excuse", {"reason": "ظرف عائلي طارئ"}, format="json"))
    assert "excuse_new" in kinds(world.t1) and "booking_cancelled" not in kinds(world.s1)
    for u in (world.s2, world.t2, world.p1):
        assert kinds(u) == []


def test_reminders_once_and_only_when_enabled(world):
    from apps.core.models import AppSettings
    from apps.scheduling.models import Booking

    o = occurrence(world.t1, in_hours=5)
    Booking.objects.create(occurrence=o, student=world.s1, idempotency_key="r")
    for _ in range(2):
        assert client_for(world.s1).get("/api/v1/notifications/unread").json()["unread"] == 1
    call_command("session_reminders")
    assert kinds(world.s1) == ["session_reminder"] and kinds(world.t1) == ["session_reminder"]
    assert kinds(world.s2) == [] and kinds(world.p1) == []
    s = AppSettings.load()
    s.session_reminders = False
    s.save()
    o2 = occurrence(world.t1, in_hours=8)
    Booking.objects.create(occurrence=o2, student=world.s1, idempotency_key="r2")
    client_for(world.s1).get("/api/v1/notifications")
    assert kinds(world.s1) == ["session_reminder"]


def test_absence_notifies_student_and_guardian_once(world, run_commits):
    from apps.scheduling.models import Booking

    o = occurrence(world.t1, in_hours=-2)
    b = Booking.objects.create(occurrence=o, student=world.s1, idempotency_key="x")
    t1 = client_for(world.t1)
    for _ in range(2):
        run_commits(lambda: t1.post(f"/api/v1/bookings/{b.id}/attendance", {"attendance": "absent"}, format="json"))
    # The absence itself, plus the first-absence warning (excuse rule), each once.
    assert sorted(kinds(world.s1)) == ["absence_warning", "attendance_absent"]
    assert sorted(kinds(world.p1)) == ["absence_warning_child", "child_absent"]
    run_commits(lambda: t1.post(f"/api/v1/bookings/{b.id}/attendance", {"attendance": "present"}, format="json"))
    assert sorted(kinds(world.s1)) == ["absence_warning", "attendance_absent"]  # presence is not announced
    assert kinds(world.s2) == []


def test_publication_reaches_enrolled_only(world, run_commits):
    c = client_for(world.admin)
    co = c.post("/api/v1/admin/courses", {"title": "دورة", "teacher": world.t1.id}, format="json").json()
    le = c.post(f"/api/v1/admin/courses/{co['id']}/lessons", {"title": "درس 1", "kind": "text", "body": "نص"}, format="json").json()
    c.post(f"/api/v1/admin/lessons/{le['id']}/state", {"state": "published"}, format="json")
    c.post(f"/api/v1/admin/courses/{co['id']}/state", {"state": "published"}, format="json")
    c.post(f"/api/v1/admin/courses/{co['id']}/enrollments", {"student": world.s1.id}, format="json")
    le2 = c.post(f"/api/v1/admin/courses/{co['id']}/lessons", {"title": "درس 2", "kind": "text", "body": "نص"}, format="json").json()
    run_commits(lambda: c.post(f"/api/v1/admin/lessons/{le2['id']}/state", {"state": "published"}, format="json"))
    t = c.post("/api/v1/admin/tests", {"title": "اختبار", "course": co["id"]}, format="json").json()
    c.post(f"/api/v1/admin/tests/{t['id']}/questions", {"kind": "true_false", "prompt": "سؤال", "answer_key": True}, format="json")
    run_commits(lambda: c.post(f"/api/v1/admin/tests/{t['id']}/state", {"state": "published"}, format="json"))
    assert sorted(kinds(world.s1)) == ["lesson_published", "quiz_published"] and kinds(world.s2) == []


def test_inbox_unread_and_mark_read(world, run_commits):
    from apps.notifications.services import notify

    for i in range(3):
        notify(world.s1, "x", f"t{i}", dedupe=f"d{i}")
    notify(world.s1, "x", "dup", dedupe="d0")  # retried event
    s1 = client_for(world.s1)
    assert s1.get("/api/v1/notifications/unread").json()["unread"] == 3
    page = s1.get("/api/v1/notifications").json()
    assert page["count"] == 3 and page["results"][0]["title"] == "t2"  # newest first
    s1.post("/api/v1/notifications/read", {"ids": [page["results"][0]["id"]]}, format="json")
    assert s1.get("/api/v1/notifications", {"unread": "1"}).json()["count"] == 2
    s1.post("/api/v1/notifications/read", {}, format="json")
    assert s1.get("/api/v1/notifications/unread").json()["unread"] == 0
    assert client_for(world.s2).get("/api/v1/notifications").json()["count"] == 0
