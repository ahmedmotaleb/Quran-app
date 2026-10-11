"""Booking integrity on real PostgreSQL, including concurrent requests (Prompt 11 acceptance)."""
import threading
from datetime import timedelta

import pytest
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from apps.core.exceptions import ApiError
from apps.scheduling import services
from apps.scheduling.models import Booking, SessionOccurrence

from .conftest import client_for, make_user, occurrence


def run_parallel(fns):
    """Run callables at the same moment on separate DB connections; return results/exceptions."""
    barrier = threading.Barrier(len(fns))
    out = [None] * len(fns)

    def worker(i, fn):
        try:
            barrier.wait()
            out[i] = fn()
        except Exception as e:  # noqa: BLE001
            out[i] = e
        finally:
            connection.close()

    threads = [threading.Thread(target=worker, args=(i, f)) for i, f in enumerate(fns)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    return out


@pytest.mark.django_db(transaction=True)
def test_two_students_race_for_the_last_seat(world):
    occ = occurrence(world.t1, capacity=1)
    res = run_parallel([
        lambda: services.book(student=world.s1, occurrence_id=occ.pk, idempotency_key="k1"),
        lambda: services.book(student=world.s2, occurrence_id=occ.pk, idempotency_key="k2"),
    ])
    wins = [r for r in res if isinstance(r, tuple)]
    losses = [r for r in res if isinstance(r, ApiError)]
    assert len(wins) == 1 and len(losses) == 1 and losses[0].code == "slot_taken"
    assert Booking.objects.filter(occurrence=occ, status="confirmed").count() == 1


@pytest.mark.django_db(transaction=True)
def test_group_capacity_holds_under_concurrency(world):
    occ = occurrence(world.t1, capacity=3, kind="group")
    students = [make_user(f"g{i}@x.test") for i in range(6)]
    res = run_parallel([lambda s=s: services.book(student=s, occurrence_id=occ.pk, idempotency_key=f"g-{s.pk}") for s in students])
    assert sum(isinstance(r, tuple) for r in res) == 3
    assert Booking.objects.filter(occurrence=occ, status="confirmed").count() == 3


@pytest.mark.django_db(transaction=True)
def test_repeated_taps_with_same_key_create_one_booking(world):
    occ = occurrence(world.t1, capacity=5)
    res = run_parallel([lambda: services.book(student=world.s1, occurrence_id=occ.pk, idempotency_key="same")] * 5)
    assert all(isinstance(r, tuple) for r in res), res
    assert sum(r[1] for r in res) == 1  # exactly one 'created'
    assert len({r[0].pk for r in res}) == 1
    assert Booking.objects.filter(student=world.s1).count() == 1


@pytest.mark.django_db(transaction=True)
def test_student_cannot_hold_overlapping_sessions(world):
    a = occurrence(world.t1, in_hours=48)
    b = occurrence(world.t2, in_hours=48.25)  # starts 15 min into session a, different teacher
    services.book(student=world.s1, occurrence_id=a.pk, idempotency_key="a")
    with pytest.raises(ApiError) as e:
        services.book(student=world.s1, occurrence_id=b.pk, idempotency_key="b")
    assert e.value.code == "student_conflict"


@pytest.mark.django_db(transaction=True)
def test_cancel_races_with_new_booking(world):
    occ = occurrence(world.t1, capacity=1)
    b1, _ = services.book(student=world.s1, occurrence_id=occ.pk, idempotency_key="c1")
    res = run_parallel([
        lambda: services.cancel(booking_id=b1.pk, by=world.s1),
        lambda: services.book(student=world.s2, occurrence_id=occ.pk, idempotency_key="c2"),
    ])
    confirmed = Booking.objects.filter(occurrence=occ, status="confirmed").count()
    assert confirmed <= 1  # never over capacity, whichever request won
    if isinstance(res[1], ApiError):
        assert res[1].code == "slot_taken"


@pytest.mark.django_db
def test_teacher_overlap_is_rejected_by_database(world):
    occurrence(world.t1, in_hours=24)
    with pytest.raises(IntegrityError), transaction.atomic():
        occurrence(world.t1, in_hours=24.5)
    # A cancelled session no longer blocks the slot.
    SessionOccurrence.objects.filter(teacher=world.t1).update(status="cancelled")
    occurrence(world.t1, in_hours=24.5)


@pytest.mark.django_db
class TestBookingApi:
    def test_book_cancel_and_rebook(self, world):
        occ = occurrence(world.t1)
        c = client_for(world.s1)
        r = c.post("/api/v1/bookings", {"occurrence": occ.pk}, HTTP_IDEMPOTENCY_KEY="api-1")
        assert r.status_code == 201
        bid = r.json()["id"]
        assert c.post("/api/v1/bookings", {"occurrence": occ.pk}, HTTP_IDEMPOTENCY_KEY="api-1").status_code == 200
        assert c.post(f"/api/v1/bookings/{bid}/cancel").json()["status"] == "cancelled"
        assert client_for(world.s2).post("/api/v1/bookings", {"occurrence": occ.pk}, HTTP_IDEMPOTENCY_KEY="api-2").status_code == 201

    def test_missing_idempotency_key_rejected(self, world):
        r = client_for(world.s1).post("/api/v1/bookings", {"occurrence": occurrence(world.t1).pk})
        assert r.json()["code"] == "idempotency_key_required"

    def test_student_cannot_cancel_inside_window_but_teacher_can(self, world):
        occ = occurrence(world.t1, in_hours=5)  # default cancel window 12 h, lead time 60 min
        b, _ = services.book(student=world.s1, occurrence_id=occ.pk, idempotency_key="w")
        assert client_for(world.s1).post(f"/api/v1/bookings/{b.pk}/cancel").json()["code"] == "cancel_window"
        assert client_for(world.t1).post(f"/api/v1/bookings/{b.pk}/cancel").status_code == 200

    def test_other_users_cannot_see_or_cancel_booking(self, world):
        b, _ = services.book(student=world.s1, occurrence_id=occurrence(world.t1).pk, idempotency_key="v")
        for u in (world.s2, world.t2):
            c = client_for(u)
            assert c.get(f"/api/v1/bookings/{b.pk}").status_code == 404
            assert c.post(f"/api/v1/bookings/{b.pk}/cancel").status_code == 404
        assert client_for(world.p1).get(f"/api/v1/bookings/{b.pk}").status_code == 200  # linked parent

    def test_slot_list_reports_seats_from_database(self, world):
        occ = occurrence(world.t1, capacity=2, kind="group")
        services.book(student=world.s1, occurrence_id=occ.pk, idempotency_key="s")
        slots = client_for(world.s2).get(f"/api/v1/teachers/{world.t1.pk}/slots").json()
        assert [s["seats_left"] for s in slots if s["id"] == occ.pk] == [1]

    def test_too_late_and_cancelled_slots_cannot_be_booked(self, world):
        soon = occurrence(world.t1, in_hours=0.5)
        assert client_for(world.s1).post("/api/v1/bookings", {"occurrence": soon.pk}, HTTP_IDEMPOTENCY_KEY="l").json()["code"] == "too_late"
        gone = occurrence(world.t2, status="cancelled")
        assert client_for(world.s1).post("/api/v1/bookings", {"occurrence": gone.pk}, HTTP_IDEMPOTENCY_KEY="g").json()["code"] == "slot_unavailable"

    def test_booking_creates_notifications_after_commit(self, world, django_capture_on_commit_callbacks):
        occ = occurrence(world.t1)
        with django_capture_on_commit_callbacks(execute=True):
            client_for(world.s1).post("/api/v1/bookings", {"occurrence": occ.pk}, HTTP_IDEMPOTENCY_KEY="n")
        assert client_for(world.s1).get("/api/v1/notifications").json()["results"][0]["kind"] == "booking_confirmed"
        assert world.t1.notifications.filter(kind="booking_new").count() == 1


@pytest.mark.django_db
def test_attendance_only_by_session_teacher_after_start(world):
    occ = occurrence(world.t1, in_hours=48)
    b, _ = services.book(student=world.s1, occurrence_id=occ.pk, idempotency_key="att")
    assert client_for(world.t1).post(f"/api/v1/bookings/{b.pk}/attendance", {"attendance": "present"}).json()["code"] == "not_started"
    SessionOccurrence.objects.filter(pk=occ.pk).update(starts_at=timezone.now() - timedelta(minutes=5), ends_at=timezone.now() + timedelta(minutes=40))
    assert client_for(world.t2).post(f"/api/v1/bookings/{b.pk}/attendance", {"attendance": "present"}).status_code == 404
    assert client_for(world.t1).post(f"/api/v1/bookings/{b.pk}/attendance", {"attendance": "present"}).json()["attendance"] == "present"
