"""Waiting list (PROMPT 44): «الانضمام إلى قائمة الانتظار» for a full session.

Seats are computed, never counted by hand: free = capacity − confirmed bookings − live offers (offered, not expired).
`tick(occurrence)` (under a row lock on the occurrence) expires lapsed offers and offers each free seat to the next
eligible waiting student, in join order, for AppSettings.waitlist_offer_hours (never past the booking cut-off).
It runs when a booking is cancelled, when the waiting list is read, and in the hourly job, so a seat freed by any path
(bulk cancellation, ended membership, deleted account) reaches the queue. While an offer is live, `services.book`
counts it as a taken seat for everyone else, so the offered student cannot be overbooked out of it.
"""
from __future__ import annotations

from datetime import timedelta

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from apps.accounts.models import AccountStatus, Role
from apps.core.audit import audit
from apps.core.exceptions import ApiError
from apps.core.models import AppSettings

from .models import Booking, SessionOccurrence, WaitlistEntry

W = WaitlistEntry.Status


def live_offers(occ_id: int, now=None, exclude_student: int | None = None):
    qs = WaitlistEntry.objects.filter(occurrence_id=occ_id, status=W.OFFERED, offer_expires_at__gt=now or timezone.now())
    return qs.exclude(student_id=exclude_student) if exclude_student else qs


def _cutoff(occ: SessionOccurrence, cfg) -> timezone.datetime:
    return occ.starts_at - timedelta(minutes=cfg.booking_lead_minutes)


def join(student, occurrence_id: int, request=None) -> WaitlistEntry:
    if student.role != Role.STUDENT or student.status != AccountStatus.ACTIVE:
        raise ApiError("not_eligible", "هذا الحساب لا يمكنه الحجز.", 403)
    now, cfg = timezone.now(), AppSettings.load()
    with transaction.atomic():
        occ = SessionOccurrence.objects.select_for_update(of=("self",)).filter(pk=occurrence_id).select_related("circle").first()
        if occ is None or occ.status != SessionOccurrence.Status.SCHEDULED or (occ.circle_id and occ.circle.state != "published"):
            raise ApiError("slot_unavailable", "لم يعد هذا الموعد متاحًا.", 409)
        if _cutoff(occ, cfg) <= now:
            raise ApiError("too_late", "يبدأ هذا الموعد قريبًا جدًا؛ لا يمكن الانتظار عليه.", 409)
        if occ.bookings.filter(student=student, status=Booking.Status.CONFIRMED).exists():
            raise ApiError("already_booked", "لديك حجز مؤكد في هذا الموعد بالفعل.", 409)
        open_ = WaitlistEntry.objects.filter(student=student, occurrence=occ, status__in=[W.WAITING, W.OFFERED]).first()
        if open_:
            return open_  # idempotent
        taken = occ.bookings.filter(status=Booking.Status.CONFIRMED).count() + live_offers(occ.pk, now).count()
        if taken < occ.capacity and not WaitlistEntry.objects.filter(occurrence=occ, status=W.WAITING).exists():
            raise ApiError("seat_available", "يوجد مقعد متاح الآن؛ احجزه مباشرة.", 409)
        try:
            with transaction.atomic():
                e = WaitlistEntry.objects.create(student=student, occurrence=occ, joined_at=now)
        except IntegrityError:
            return WaitlistEntry.objects.get(student=student, occurrence=occ, status__in=[W.WAITING, W.OFFERED])
        audit("waitlist.joined", actor=student, target=e, request=request, occurrence=occ.pk)
    tick(occurrence_id)
    e.refresh_from_db()
    return e


def leave(student, entry_id: int, request=None) -> WaitlistEntry:
    with transaction.atomic():
        e = WaitlistEntry.objects.select_for_update().filter(pk=entry_id, student=student).first()
        if e is None:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        if e.status in (W.WAITING, W.OFFERED):
            was_offer = e.status == W.OFFERED
            e.status, e.resolved_at = W.CANCELLED, timezone.now()
            e.save(update_fields=["status", "resolved_at"])
            audit("waitlist.left", actor=student, target=e, request=request, declined_offer=was_offer)
    tick(e.occurrence_id)  # a declined offer goes to the next person
    return e


def accept(student, entry_id: int, idempotency_key: str, request=None) -> Booking:
    from . import services

    with transaction.atomic():
        e = WaitlistEntry.objects.select_for_update().filter(pk=entry_id, student=student).first()
        if e is None:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        if e.status == W.BOOKED and e.booking_id:
            return e.booking  # idempotent
        if e.status != W.OFFERED or e.offer_expires_at <= timezone.now():
            raise ApiError("offer_expired", "انتهت مهلة العرض. ما زلت في القائمة إن لم تخرج منها.", 409)
        b, _ = services.book(student=student, occurrence_id=e.occurrence_id, idempotency_key=idempotency_key)  # the held seat
        e.status, e.resolved_at, e.booking = W.BOOKED, timezone.now(), b
        e.save(update_fields=["status", "resolved_at", "booking"])
        audit("waitlist.accepted", actor=student, target=e, request=request, booking=b.pk)
        return b


def tick(occurrence_id: int) -> int:
    """Expire lapsed offers and offer free seats to the next eligible students. Returns the number of new offers."""
    now, cfg = timezone.now(), AppSettings.load()
    offered: list[int] = []
    with transaction.atomic():
        occ = SessionOccurrence.objects.select_for_update(of=("self",)).filter(pk=occurrence_id).select_related("circle").first()
        if occ is None:
            return 0
        for e in WaitlistEntry.objects.select_for_update().filter(occurrence=occ, status=W.OFFERED, offer_expires_at__lte=now):
            e.status, e.resolved_at = W.EXPIRED, now
            e.save(update_fields=["status", "resolved_at"])
            audit("waitlist.offer_expired", target=e, occurrence=occ.pk, student=e.student_id)
        open_q = WaitlistEntry.objects.select_for_update().filter(occurrence=occ, status__in=[W.WAITING, W.OFFERED])
        closed = (occ.status != SessionOccurrence.Status.SCHEDULED or _cutoff(occ, cfg) <= now
                  or (occ.circle_id and occ.circle.state != "published"))
        if closed:
            n = open_q.update(status=W.CLOSED, resolved_at=now)
            if n:
                audit("waitlist.closed", target=occ, entries=n)
            return 0
        free = occ.capacity - occ.bookings.filter(status=Booking.Status.CONFIRMED).count() - live_offers(occ.pk, now).count()
        if free <= 0:
            return 0
        until = min(now + timedelta(hours=cfg.waitlist_offer_hours), _cutoff(occ, cfg))
        for e in WaitlistEntry.objects.select_for_update(of=("self",)).filter(occurrence=occ, status=W.WAITING).select_related("student"):
            if free <= 0:
                break
            st = e.student
            busy = Booking.objects.filter(student=st, status=Booking.Status.CONFIRMED, occurrence__status=SessionOccurrence.Status.SCHEDULED,
                                          occurrence__starts_at__lt=occ.ends_at, occurrence__ends_at__gt=occ.starts_at).exists()
            if st.status != AccountStatus.ACTIVE or busy:
                e.status, e.resolved_at = W.CLOSED, now  # ineligible now (suspended, or booked at the same time)
                e.save(update_fields=["status", "resolved_at"])
                continue
            e.status, e.offered_at, e.offer_expires_at = W.OFFERED, now, until
            e.save(update_fields=["status", "offered_at", "offer_expires_at"])
            audit("waitlist.offered", target=e, occurrence=occ.pk, student=st.pk, expires_at=until.isoformat())
            offered.append(e.pk)
            free -= 1
    for pk in offered:
        transaction.on_commit(lambda pk=pk: _notify_offer(pk))
    return len(offered)


def tick_all() -> int:
    """Hourly: every session with an open waiting list."""
    ids = (WaitlistEntry.objects.filter(status__in=[W.WAITING, W.OFFERED]).values_list("occurrence_id", flat=True).distinct())
    return sum(tick(i) for i in list(ids))


def seat_freed(occurrence_id: int) -> None:
    """Called after a booking on this session is cancelled (on commit)."""
    if WaitlistEntry.objects.filter(occurrence_id=occurrence_id, status=W.WAITING).exists():
        tick(occurrence_id)


def _notify_offer(entry_id: int) -> None:
    from apps.notifications.services import notify

    e = WaitlistEntry.objects.select_related("occurrence__teacher").filter(pk=entry_id, status=W.OFFERED).first()
    if e is None:
        return
    notify(e.student, "waitlist_offer", "توفّر مقعد في جلسة تنتظرها",
           f"مع {e.occurrence.teacher.full_name}. احجزه قبل انتهاء المهلة وإلا انتقل إلى التالي.",
           link="/bookings", dedupe=f"waitlist:{e.pk}:offer", data={"waitlist": e.pk, "occurrence": e.occurrence_id})


def entry_out(e: WaitlistEntry) -> dict:
    o = e.occurrence
    ahead = (WaitlistEntry.objects.filter(occurrence=o, status=W.WAITING).filter(Q(joined_at__lt=e.joined_at) | Q(joined_at=e.joined_at, pk__lt=e.pk)).count()
             if e.status == W.WAITING else 0)
    return {"id": e.id, "status": e.status, "joined_at": e.joined_at.isoformat(), "position": ahead + 1 if e.status == W.WAITING else None,
            "offer_expires_at": e.offer_expires_at.isoformat() if e.offer_expires_at and e.status == W.OFFERED else None,
            "occurrence": {"id": o.pk, "starts_at": o.starts_at.isoformat(), "ends_at": o.ends_at.isoformat(), "teacher": o.teacher_id,
                           "teacher_name": o.teacher.full_name, "kind": o.kind, "circle_name": o.circle.name if o.circle_id else None}}
