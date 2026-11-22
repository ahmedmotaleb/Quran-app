"""Attendance by joining (owner request 22 Nov 2026): «انضم إلى الجلسة» records the student's attendance and tells
the teacher (apps/scheduling/checkin.py)."""
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.notifications.models import Notification
from apps.notifications.push import payload_for
from apps.scheduling.models import Booking, SessionOccurrence

from .conftest import client_for

pytestmark = pytest.mark.django_db


def booked(world, start_in_min=3, minutes=45):
    st = timezone.now() + timedelta(minutes=start_in_min)
    o = SessionOccurrence.objects.create(teacher=world.t1, starts_at=st, ends_at=st + timedelta(minutes=minutes),
                                         meeting_url="https://meet.google.com/abc-defg-hij", meeting_provider="google_meet", title="حلقة الفجر")
    return Booking.objects.create(occurrence=o, student=world.s1, idempotency_key=f"ci-{o.pk}")


def join(world, b, cap):
    with cap(execute=True):
        return client_for(world.s1).post(f"/api/v1/bookings/{b.pk}/join")


def test_joining_marks_present_and_tells_the_teacher_once(world, django_capture_on_commit_callbacks):
    b = booked(world, start_in_min=3)
    r = join(world, b, django_capture_on_commit_callbacks)
    assert r.status_code == 200 and r.json()["url"] == "https://meet.google.com/abc-defg-hij" and r.json()["attendance"] == "present"
    b.refresh_from_db()
    assert b.attendance == "present" and b.attendance_marked_by_id == world.s1.pk and b.attendance_marked_at is not None
    n = Notification.objects.get(recipient=world.t1, kind="attendance_joined")
    assert n.title == f"حضر: {world.s1.full_name}" and "حلقة الفجر" in n.body and n.link == "/teacher/schedule"
    p = payload_for("attendance_joined", n.link)
    assert p["body"] == "انضم طالب إلى جلستك الآن." and world.s1.full_name not in str(p)          # lock screen stays generic
    again = join(world, b, django_capture_on_commit_callbacks)                                     # rejoining: same link, nothing new
    assert again.status_code == 200 and again.json()["attendance"] is None
    assert Notification.objects.filter(recipient=world.t1, kind="attendance_joined").count() == 1
    row = next(x for x in client_for(world.t1).get("/api/v1/teacher/occurrences?days=2").json() if x["id"] == b.occurrence_id)
    assert row["bookings"][0]["joined"] is True and row["bookings"][0]["attendance"] == "present"


def test_joining_more_than_ten_minutes_late_marks_late(world, django_capture_on_commit_callbacks):
    b = booked(world, start_in_min=-15, minutes=60)
    assert join(world, b, django_capture_on_commit_callbacks).json()["attendance"] == "late"
    assert Notification.objects.get(recipient=world.t1, kind="attendance_joined").title.startswith("حضر متأخرًا")


def test_a_teachers_mark_is_never_overwritten_and_can_still_be_corrected(world, django_capture_on_commit_callbacks):
    b = booked(world, start_in_min=-5)
    t = client_for(world.t1)
    assert t.post(f"/api/v1/bookings/{b.pk}/attendance", {"attendance": "absent"}, format="json").status_code == 200
    assert join(world, b, django_capture_on_commit_callbacks).json()["attendance"] is None
    b.refresh_from_db()
    assert b.attendance == "absent" and not Notification.objects.filter(kind="attendance_joined").exists()
    SessionOccurrence.objects.filter(pk=b.occurrence_id).update(status="cancelled")   # free the teacher's time
    b2 = booked(world, start_in_min=-1)                                       # another session: joined, then corrected
    assert join(world, b2, django_capture_on_commit_callbacks).json()["attendance"] == "present"
    assert t.post(f"/api/v1/bookings/{b2.pk}/attendance", {"attendance": "late"}, format="json").status_code == 200
    b2.refresh_from_db()
    assert b2.attendance == "late" and b2.attendance_marked_by_id == world.t1.pk


def test_no_mark_when_the_join_is_refused(world, django_capture_on_commit_callbacks):
    b = booked(world, start_in_min=120)                                       # outside the join window
    assert join(world, b, django_capture_on_commit_callbacks).status_code == 409
    b.refresh_from_db()
    assert b.attendance == "" and not Notification.objects.filter(kind="attendance_joined").exists()
