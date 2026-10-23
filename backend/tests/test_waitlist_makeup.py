"""Waiting list and make-up sessions (PROMPT 44): capacity, concurrency, duplicates, expiry."""
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.accounts.models import AccountStatus, AdminProfile, Role, User
from apps.accounts import admin_access as aa
from apps.core.exceptions import ApiError
from apps.core.models import AppSettings, AuditEvent
from apps.scheduling import makeup, services, waitlist
from apps.scheduling.models import Booking, BookingExcuse, MakeupCredit, WaitlistEntry

from .conftest import client_for, make_user, occurrence
from .test_booking import run_parallel

W = WaitlistEntry.Status


def full_session(world, cap=1):
    occ = occurrence(world.t1, capacity=cap)
    services.book(student=world.s1, occurrence_id=occ.pk, idempotency_key="seat-s1")
    return occ


# --- waiting list -------------------------------------------------------------------------------
@pytest.mark.django_db
def test_join_only_when_full_once_and_in_order(world):
    occ = occurrence(world.t1, capacity=1)
    with pytest.raises(ApiError) as e:
        waitlist.join(world.s2, occ.pk)
    assert e.value.code == "seat_available"
    services.book(student=world.s1, occurrence_id=occ.pk, idempotency_key="a")
    with pytest.raises(ApiError) as e:
        waitlist.join(world.s1, occ.pk)
    assert e.value.code == "already_booked"
    s3 = make_user("s3w@x.test")
    first = waitlist.join(world.s2, occ.pk)
    assert waitlist.join(world.s2, occ.pk).pk == first.pk  # no duplicate
    second = waitlist.join(s3, occ.pk)
    r = client_for(s3).get("/api/v1/waitlist").json()["results"][0]
    assert r["status"] == "waiting" and r["position"] == 2 and second.status == W.WAITING
    assert AuditEvent.objects.filter(action="waitlist.joined").count() == 2


@pytest.mark.django_db
def test_freed_seat_is_offered_held_and_accepted(world, django_capture_on_commit_callbacks):
    occ = full_session(world)
    e = waitlist.join(world.s2, occ.pk)
    other = make_user("other@x.test")
    b = Booking.objects.get(occurrence=occ, student=world.s1)
    with django_capture_on_commit_callbacks(execute=True):
        services.cancel(booking_id=b.pk, by=world.t1, reason="ظرف طارئ")
    e.refresh_from_db()
    assert e.status == W.OFFERED and e.offer_expires_at > timezone.now()
    # The held seat is not available to anyone else…
    with pytest.raises(ApiError) as x:
        services.book(student=other, occurrence_id=occ.pk, idempotency_key="steal")
    assert x.value.code == "slot_taken"
    slot = client_for(other).get(f"/api/v1/teachers/{world.t1.pk}/slots").json()
    rows = slot["results"] if isinstance(slot, dict) else slot
    assert [s["seats_left"] for s in rows if s["id"] == occ.pk] in ([0], [])
    # …and the offered student books it (idempotent on retry).
    c = client_for(world.s2)
    r = c.post(f"/api/v1/waitlist/{e.pk}/accept", HTTP_IDEMPOTENCY_KEY="acc-1")
    assert r.status_code == 201 and r.json()["occurrence"]["id"] == occ.pk
    assert c.post(f"/api/v1/waitlist/{e.pk}/accept", HTTP_IDEMPOTENCY_KEY="acc-1").status_code == 201
    assert Booking.objects.filter(occurrence=occ, status="confirmed").count() == 1
    from apps.notifications.models import Notification

    assert Notification.objects.filter(recipient=world.s2, kind="waitlist_offer").exists()


@pytest.mark.django_db
def test_expired_offer_moves_to_the_next_person(world):
    occ = full_session(world)
    s3 = make_user("s3x@x.test")
    a, b = waitlist.join(world.s2, occ.pk), waitlist.join(s3, occ.pk)
    Booking.objects.filter(occurrence=occ).update(status="cancelled")  # a bulk path: the hourly tick catches it
    assert waitlist.tick_all() == 1
    a.refresh_from_db()
    assert a.status == W.OFFERED
    WaitlistEntry.objects.filter(pk=a.pk).update(offer_expires_at=timezone.now() - timedelta(seconds=1))
    with pytest.raises(ApiError) as x:
        waitlist.accept(world.s2, a.pk, "late")
    assert x.value.code == "offer_expired"
    waitlist.tick(occ.pk)
    a.refresh_from_db(); b.refresh_from_db()
    assert a.status == W.EXPIRED and b.status == W.OFFERED
    # Declining passes it on too; nobody is left: nothing offered, no error.
    waitlist.leave(s3, b.pk)
    b.refresh_from_db()
    assert b.status == W.CANCELLED and waitlist.tick(occ.pk) == 0


@pytest.mark.django_db
def test_offer_never_outlives_the_booking_cutoff_and_closes_with_the_session(world):
    cfg = AppSettings.load()
    occ = occurrence(world.t1, capacity=1, in_hours=3)
    services.book(student=world.s1, occurrence_id=occ.pk, idempotency_key="x")
    e = waitlist.join(world.s2, occ.pk)
    Booking.objects.filter(occurrence=occ).update(status="cancelled")
    waitlist.tick(occ.pk)
    e.refresh_from_db()
    assert e.offer_expires_at <= occ.starts_at - timedelta(minutes=cfg.booking_lead_minutes)
    services.cancel_occurrence(occurrence_id=occ.pk, by=world.t1, reason="إلغاء")
    waitlist.tick(occ.pk)
    e.refresh_from_db()
    assert e.status == W.CLOSED


@pytest.mark.django_db
def test_suspended_waiting_student_is_skipped(world):
    occ = full_session(world)
    s3 = make_user("s3s@x.test")
    a, b = waitlist.join(world.s2, occ.pk), waitlist.join(s3, occ.pk)
    User.objects.filter(pk=world.s2.pk).update(status=AccountStatus.SUSPENDED)
    Booking.objects.filter(occurrence=occ).update(status="cancelled")
    waitlist.tick(occ.pk)
    a.refresh_from_db(); b.refresh_from_db()
    assert a.status == W.CLOSED and b.status == W.OFFERED


@pytest.mark.django_db(transaction=True)
def test_concurrent_accept_and_direct_booking_never_overbook(world):
    occ = full_session(world, cap=1)
    e = waitlist.join(world.s2, occ.pk)
    Booking.objects.filter(occurrence=occ).update(status="cancelled")
    waitlist.tick(occ.pk)
    others = [make_user(f"race{i}@x.test") for i in range(3)]
    res = run_parallel([lambda: waitlist.accept(world.s2, e.pk, "acc")] +
                       [lambda o=o: services.book(student=o, occurrence_id=occ.pk, idempotency_key="r") for o in others])
    assert isinstance(res[0], Booking)
    assert all(isinstance(r, ApiError) and r.code == "slot_taken" for r in res[1:])
    assert Booking.objects.filter(occurrence=occ, status="confirmed").count() == 1


@pytest.mark.django_db(transaction=True)
def test_concurrent_joins_create_one_entry(world):
    occ = full_session(world)
    res = run_parallel([lambda: waitlist.join(world.s2, occ.pk) for _ in range(4)])
    assert all(isinstance(r, WaitlistEntry) for r in res)
    assert WaitlistEntry.objects.filter(occurrence=occ, student=world.s2).count() == 1


# --- make-up sessions ---------------------------------------------------------------------------
def excused_booking(world):
    past = occurrence(world.t1, in_hours=-48)
    b = Booking.objects.create(occurrence=past, student=world.s1, idempotency_key="past", attendance="excused")
    BookingExcuse.objects.create(booking=b, student=world.s1, reason="مرض", status=BookingExcuse.Status.APPROVED)
    return b


@pytest.mark.django_db
def test_grant_once_for_an_approved_excuse_and_use_with_the_same_teacher(world):
    b = excused_booking(world)
    t = client_for(world.t1)
    r = t.post(f"/api/v1/bookings/{b.pk}/makeup")
    assert r.status_code == 201 and r.json()["status"] == "available"
    assert t.post(f"/api/v1/bookings/{b.pk}/makeup").json()["code"] == "already_granted"  # no duplicate
    assert client_for(world.t2).post(f"/api/v1/bookings/{b.pk}/makeup").status_code == 404
    credit = MakeupCredit.objects.get(source_booking=b)
    s = client_for(world.s1)
    assert s.get("/api/v1/makeup").json()["results"][0]["id"] == credit.pk
    other_teacher = occurrence(world.t2)
    from apps.scheduling.models import SessionOccurrence  # noqa: F401
    from apps.accounts.models import TeacherProfile
    TeacherProfile.objects.filter(user__in=[world.t1, world.t2]).update(approved_at=timezone.now())
    r = s.post("/api/v1/bookings", {"occurrence": other_teacher.pk, "makeup_credit": credit.pk}, format="json", HTTP_IDEMPOTENCY_KEY="m1")
    assert r.json()["code"] == "makeup_teacher" and not Booking.objects.filter(occurrence=other_teacher).exists()
    same = occurrence(world.t1, in_hours=72)
    r = s.post("/api/v1/bookings", {"occurrence": same.pk, "makeup_credit": credit.pk}, format="json", HTTP_IDEMPOTENCY_KEY="m2")
    assert r.status_code == 201
    credit.refresh_from_db()
    assert credit.status == "used" and credit.used_booking_id == r.json()["id"]
    again = occurrence(world.t1, in_hours=96)
    r = s.post("/api/v1/bookings", {"occurrence": again.pk, "makeup_credit": credit.pk}, format="json", HTTP_IDEMPOTENCY_KEY="m3")
    assert r.json()["code"] == "makeup_unavailable"
    # The teacher cancels the make-up booking: the credit comes back.
    services.cancel(booking_id=credit.used_booking_id, by=world.t1, reason="ظرف")
    credit.refresh_from_db()
    assert credit.status == "available"
    assert {"makeup.granted", "makeup.used", "makeup.returned"} <= set(AuditEvent.objects.values_list("action", flat=True))


@pytest.mark.django_db
def test_grant_rules_settings_and_expiry(world):
    b = excused_booking(world)
    pending = occurrence(world.t1, in_hours=-24)
    pb = Booking.objects.create(occurrence=pending, student=world.s1, idempotency_key="p2")
    BookingExcuse.objects.create(booking=pb, student=world.s1, reason="x")
    assert client_for(world.t1).post(f"/api/v1/bookings/{pb.pk}/makeup").json()["code"] == "not_excused"
    cfg = AppSettings.load()
    cfg.makeup_granters = "admins"
    cfg.save()
    assert client_for(world.t1).post(f"/api/v1/bookings/{b.pk}/makeup").status_code == 403
    support = make_user("supm@x.test", Role.ADMIN, owner=False)
    AdminProfile.objects.create(user=support, access_level="admin", preset="support", permissions=sorted(aa.PRESETS["support"]))
    assert client_for(support).post(f"/api/v1/admin/bookings/{b.pk}/makeup").status_code == 403
    assert client_for(world.admin).post(f"/api/v1/admin/bookings/{b.pk}/makeup").status_code == 201
    cfg.makeup_enabled = False
    cfg.save()
    assert client_for(world.admin).post(f"/api/v1/admin/bookings/{pb.pk}/makeup").json()["code"] == "makeup_disabled"
    MakeupCredit.objects.update(expires_at=timezone.now() - timedelta(minutes=1))
    assert makeup.expire_all() == 1 and MakeupCredit.objects.get().status == "expired"


@pytest.mark.django_db(transaction=True)
def test_concurrent_grants_create_one_credit(world):
    b = excused_booking(world)
    res = run_parallel([lambda: makeup.grant(b.pk, world.t1) for _ in range(3)])
    assert sum(isinstance(r, MakeupCredit) for r in res) == 1
    assert MakeupCredit.objects.filter(source_booking=b).count() == 1
