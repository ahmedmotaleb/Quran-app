from datetime import date, time, timedelta

import pytest
from django.utils import timezone

from apps.scheduling.models import AvailabilityRule, Booking, SessionOccurrence
from apps.scheduling.services import generate_occurrences

from .conftest import client_for, occurrence


def at(hours):
    return (timezone.now() + timedelta(hours=hours)).replace(minute=0, second=0, microsecond=0)


def test_teacher_lists_own_sessions_with_bookings_only(world):
    recent = occurrence(world.t1, in_hours=-24 * 5)
    occurrence(world.t1, in_hours=-24 * 10)  # older than a week: not listed
    o = occurrence(world.t1, in_hours=30)
    occurrence(world.t2, in_hours=30)
    Booking.objects.create(occurrence=o, student=world.s1, idempotency_key="k1")
    rows = client_for(world.t1).get("/api/v1/teacher/occurrences").json()
    assert [r["id"] for r in rows] == [recent.id, o.id]
    assert rows[1]["bookings"][0]["student_name"] == world.s1.full_name
    assert "email" not in rows[1]["bookings"][0]
    assert client_for(world.s1).get("/api/v1/teacher/occurrences").status_code == 403


def test_open_slot_validates_window_and_overlap(world):
    t1 = client_for(world.t1)
    r = t1.post("/api/v1/teacher/occurrences", {"starts_at": at(30).isoformat()}, format="json")
    assert r.status_code == 201 and r.json()["status"] == "scheduled"
    assert t1.post("/api/v1/teacher/occurrences", {"starts_at": (at(30) + timedelta(minutes=20)).isoformat()}, format="json").json()["code"] == "overlap"
    assert t1.post("/api/v1/teacher/occurrences", {"starts_at": (timezone.now() + timedelta(minutes=10)).isoformat()}, format="json").json()["code"] == "outside_window"
    assert t1.post("/api/v1/teacher/occurrences", {"starts_at": at(24 * 60).isoformat()}, format="json").json()["code"] == "outside_window"
    # The new slot is bookable by students.
    assert [x["id"] for x in client_for(world.s1).get(f"/api/v1/teachers/{world.t1.pk}/slots").json()] == [r.json()["id"]]


def test_close_slot_rules(world):
    t1 = client_for(world.t1)
    free, booked = occurrence(world.t1, in_hours=30), occurrence(world.t1, in_hours=40)
    Booking.objects.create(occurrence=booked, student=world.s1, idempotency_key="k")
    assert t1.post(f"/api/v1/teacher/occurrences/{booked.id}/close").json()["code"] == "has_bookings"
    assert client_for(world.t2).post(f"/api/v1/teacher/occurrences/{free.id}/close").status_code == 404
    assert t1.post(f"/api/v1/teacher/occurrences/{free.id}/close").status_code == 204
    free.refresh_from_db()
    assert free.status == "cancelled"
    assert free.id not in [x["id"] for x in client_for(world.s1).get(f"/api/v1/teachers/{world.t1.pk}/slots").json()]


def test_closed_slot_is_not_regenerated_by_rules(world):
    tomorrow = timezone.localdate() + timedelta(days=1)
    AvailabilityRule.objects.create(teacher=world.t1, weekday=tomorrow.weekday(), start_time=time(16), end_time=time(17),
                                    timezone="Africa/Cairo", session_minutes=45, valid_from=date.today())
    assert generate_occurrences(world.t1, start=tomorrow, days=1) == 1
    o = SessionOccurrence.objects.get(teacher=world.t1)
    assert client_for(world.t1).post(f"/api/v1/teacher/occurrences/{o.id}/close").status_code == 204
    assert generate_occurrences(world.t1, start=tomorrow, days=1) == 0
    assert SessionOccurrence.objects.filter(teacher=world.t1).exclude(status="cancelled").count() == 0


@pytest.mark.parametrize("value", ["present", "late"])
def test_attendance_after_start(world, value):
    o = occurrence(world.t1, in_hours=-1)
    b = Booking.objects.create(occurrence=o, student=world.s1, idempotency_key="a")
    r = client_for(world.t1).post(f"/api/v1/bookings/{b.id}/attendance", {"attendance": value}, format="json")
    assert r.status_code == 200
    b.refresh_from_db()
    assert b.attendance == value


def test_teacher_cancellation_notifies_student(world, django_capture_on_commit_callbacks):
    from apps.notifications.models import Notification

    b = Booking.objects.create(occurrence=occurrence(world.t1, in_hours=5), student=world.s1, idempotency_key="c")
    with django_capture_on_commit_callbacks(execute=True):
        assert client_for(world.t1).post(f"/api/v1/bookings/{b.id}/cancel", {"reason": "سفر"}, format="json").status_code == 200
    assert Notification.objects.filter(recipient=world.s1, kind="booking_cancelled").count() == 1
