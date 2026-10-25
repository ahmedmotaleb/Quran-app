"""Circle membership (owner decision 20 October 2026): a circle has members, and members are booked into every
upcoming session of the circle automatically.

- Joining: the circle must be published, the student active, and active members < circle capacity (the circle row is
  locked, so two admins cannot overfill it). The student gets one notification, not one per session.
- Sync: each upcoming scheduled session gets a confirmed booking for each active member who has none, unless the
  session is full or the student has another session at that time (left to the admin; reported as skipped). It runs
  when someone joins, when sessions are scheduled, and hourly (`sync_circle_members`).
- Leaving (or moving to another circle): the membership ends; future bookings in this circle's sessions are
  cancelled with the reason; past bookings and attendance stay.
"""
from __future__ import annotations

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.accounts.models import AccountStatus, Role
from apps.core.exceptions import ApiError

from .models import Booking, Circle, CircleMember, SessionOccurrence


class MembershipError(ApiError):
    pass


def active_count(circle: Circle) -> int:
    return CircleMember.objects.filter(circle=circle, active=True).count()


def sync_member(m: CircleMember, now=None) -> dict:
    """Book one member into the circle's upcoming sessions. Returns {booked, full, conflict}."""
    now = now or timezone.now()
    out = {"booked": 0, "full": 0, "conflict": 0}
    if not m.active or m.circle.state != Circle.State.PUBLISHED or m.student.status != AccountStatus.ACTIVE:
        return out
    occs = (SessionOccurrence.objects.filter(circle=m.circle, status=SessionOccurrence.Status.SCHEDULED, starts_at__gt=now)
            .exclude(bookings__student=m.student, bookings__status=Booking.Status.CONFIRMED).order_by("starts_at"))
    for occ_id in occs.values_list("pk", flat=True):
        with transaction.atomic():
            occ = SessionOccurrence.objects.select_for_update().get(pk=occ_id)
            if occ.bookings.filter(status=Booking.Status.CONFIRMED).count() >= occ.capacity:
                out["full"] += 1
                continue
            clash = Booking.objects.filter(student=m.student, status=Booking.Status.CONFIRMED,
                                           occurrence__status=SessionOccurrence.Status.SCHEDULED,
                                           occurrence__starts_at__lt=occ.ends_at, occurrence__ends_at__gt=occ.starts_at).exists()
            if clash:
                out["conflict"] += 1
                continue
            try:
                with transaction.atomic():
                    Booking.objects.create(occurrence=occ, student=m.student, idempotency_key=f"circle-{m.pk}-{occ.pk}")
                out["booked"] += 1
            except IntegrityError:  # booked concurrently, or a cancelled earlier copy holds the key
                b = Booking.objects.filter(student=m.student, idempotency_key=f"circle-{m.pk}-{occ.pk}").first()
                if b and b.status == Booking.Status.CANCELLED:
                    b.status, b.cancelled_at, b.cancelled_by, b.cancel_reason = Booking.Status.CONFIRMED, None, None, ""
                    b.save(update_fields=["status", "cancelled_at", "cancelled_by", "cancel_reason", "updated_at"])
                    out["booked"] += 1
    return out


def join(circle: Circle, student, by) -> tuple[CircleMember, dict]:
    """Add a student; raises MembershipError (code already_member / circle_full / not_published / inactive)."""
    if student.role != Role.STUDENT or student.status != AccountStatus.ACTIVE:
        raise MembershipError("inactive", "الحساب غير نشط أو ليس حساب طالب.", 409)
    with transaction.atomic():
        c = Circle.objects.select_for_update().get(pk=circle.pk)
        if c.state != Circle.State.PUBLISHED:
            raise MembershipError("not_published", "الحلقة غير منشورة.", 409)
        if CircleMember.objects.filter(circle=c, student=student, active=True).exists():
            raise MembershipError("already_member", "عضو في هذه الحلقة بالفعل.", 409)
        if active_count(c) >= c.capacity:
            raise MembershipError("circle_full", f"اكتملت الحلقة ({c.capacity} طالبًا).", 409)
        m = CircleMember.objects.create(circle=c, student=student, created_by=by)
    result = sync_member(m)
    from apps.notifications.services import after_commit

    after_commit(student, "circle_joined", f"انضممت إلى {c.name}", f"مع {c.teacher.display_name} · حُجزت {result['booked']} جلسة قادمة",
                 link="/sessions", dedupe=f"circle_member:{m.pk}:joined", data={"circle": c.pk})
    after_commit(c.teacher, "circle_member_new", "طالب جديد في حلقتك", f"{student.full_name} · {c.name}",
                 link="/teacher/schedule", dedupe=f"circle_member:{m.pk}:teacher", data={"circle": c.pk})
    return m, result


def leave(m: CircleMember, by, reason: str = "", now=None) -> int:
    """End a membership and cancel the student's future bookings in this circle. Returns the number cancelled."""
    now = now or timezone.now()
    with transaction.atomic():
        m = CircleMember.objects.select_for_update().select_related("circle", "student").get(pk=m.pk)
        if not m.active:
            return 0
        m.active, m.ended_at, m.ended_by, m.end_reason = False, now, by, reason[:200]
        m.save(update_fields=["active", "ended_at", "ended_by", "end_reason", "updated_at"])
        n = Booking.objects.filter(student=m.student, status=Booking.Status.CONFIRMED, occurrence__circle=m.circle,
                                   occurrence__starts_at__gt=now).update(
            status=Booking.Status.CANCELLED, cancelled_at=now, cancelled_by=by, cancel_reason=(reason or "انتهت العضوية في الحلقة")[:200],
            updated_at=now)
    from apps.notifications.services import after_commit

    after_commit(m.student, "circle_left", f"انتهت عضويتك في {m.circle.name}", f"أُلغيت {n} جلسة قادمة في هذه الحلقة.",
                 link="/sessions", dedupe=f"circle_member:{m.pk}:left", data={"circle": m.circle_id})
    return n


def sync_circle(circle: Circle) -> dict:
    total = {"booked": 0, "full": 0, "conflict": 0}
    for m in CircleMember.objects.filter(circle=circle, active=True).select_related("circle", "student"):
        for k, v in sync_member(m).items():
            total[k] += v
    return total
