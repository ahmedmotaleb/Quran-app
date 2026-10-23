"""Make-up sessions (PROMPT 44): «جلسة تعويضية» for an approved excuse.

- Granted per excused booking, at most once (one-to-one with the source booking), by its teacher or an admin
  (AppSettings.makeup_granters: "teachers_admins" or "admins"; admins need `excuses.review`), only while
  AppSettings.makeup_enabled. Nothing is granted automatically.
- Valid for makeup_expiry_days; it books one replacement session with the same teacher (services.book with
  makeup_credit_id). If the teacher or an admin later cancels that booking, the credit becomes available again.
- Every grant, use, return and expiry is audited.
"""
from __future__ import annotations

from datetime import timedelta

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.accounts.models import Role
from apps.core.audit import audit
from apps.core.exceptions import ApiError
from apps.core.models import AppSettings

from .models import Booking, BookingExcuse, MakeupCredit

M = MakeupCredit.Status


def can_grant(user, booking: Booking, cfg=None) -> bool:
    cfg = cfg or AppSettings.load()
    if user.role == Role.ADMIN:
        from apps.accounts.admin_access import has

        return has(user, "excuses.review")
    return cfg.makeup_granters == "teachers_admins" and user.role == Role.TEACHER and booking.occurrence.teacher_id == user.pk


def grant(booking_id: int, by, request=None) -> MakeupCredit:
    cfg = AppSettings.load()
    if not cfg.makeup_enabled:
        raise ApiError("makeup_disabled", "الجلسات التعويضية غير مفعّلة في الإعدادات.", 409)
    with transaction.atomic():
        b = Booking.objects.select_for_update(of=("self",)).select_related("occurrence").filter(pk=booking_id).first()
        if b is None or not (by.role == Role.ADMIN or b.occurrence.teacher_id == by.pk):
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        if not can_grant(by, b, cfg):
            raise ApiError("permission_denied", "منح الجلسات التعويضية متاح للإدارة فقط حسب الإعدادات.", 403)
        ex = BookingExcuse.objects.filter(booking=b).first()
        if ex is None or ex.status != BookingExcuse.Status.APPROVED:
            raise ApiError("not_excused", "تُمنح الجلسة التعويضية لغياب بعذر مقبول فقط.", 409)
        if MakeupCredit.objects.filter(source_booking=b).exists():
            raise ApiError("already_granted", "مُنحت جلسة تعويضية لهذا الغياب من قبل.", 409)
        try:
            with transaction.atomic():
                c = MakeupCredit.objects.create(student_id=b.student_id, teacher_id=b.occurrence.teacher_id, source_booking=b, issued_by=by,
                                                expires_at=timezone.now() + timedelta(days=cfg.makeup_expiry_days))
        except IntegrityError:  # granted at the same moment by someone else
            raise ApiError("already_granted", "مُنحت جلسة تعويضية لهذا الغياب من قبل.", 409) from None
        audit("makeup.granted", actor=by, target=c, request=request, booking=b.pk, student=b.student_id, days=cfg.makeup_expiry_days)
    from apps.notifications.services import after_commit

    after_commit(c.student, "makeup_granted", "مُنحت لك جلسة تعويضية",
                 f"احجز موعدًا بديلًا مع معلمك قبل انتهاء صلاحيتها ({cfg.makeup_expiry_days} يومًا).", link="/bookings",
                 dedupe=f"makeup:{c.pk}:granted", data={"makeup": c.pk})
    return c


def use(student, credit_id: int, booking: Booking, now) -> MakeupCredit:
    """Inside services.book's transaction: the credit pays for this booking (same teacher, not expired)."""
    c = MakeupCredit.objects.select_for_update().filter(pk=credit_id, student=student).first()
    if c is None or c.status != M.AVAILABLE or c.expires_at <= now:
        raise ApiError("makeup_unavailable", "الجلسة التعويضية غير متاحة أو انتهت صلاحيتها.", 409)
    if booking.occurrence.teacher_id != c.teacher_id:
        raise ApiError("makeup_teacher", "تُحجز الجلسة التعويضية مع المعلم نفسه.", 409)
    c.status, c.used_at, c.used_booking = M.USED, now, booking
    c.save(update_fields=["status", "used_at", "used_booking"])
    audit("makeup.used", actor=student, target=c, booking=booking.pk)
    return c


def booking_cancelled(b: Booking, now) -> None:
    """A make-up booking cancelled by the teacher/admin (or rescheduled) returns the credit if it has not expired."""
    c = MakeupCredit.objects.select_for_update().filter(used_booking=b, status=M.USED).first()
    if c is None:
        return
    if c.expires_at > now:
        c.status, c.used_at, c.used_booking = M.AVAILABLE, None, None
        c.save(update_fields=["status", "used_at", "used_booking"])
        audit("makeup.returned", target=c, booking=b.pk)


def expire_all(now=None) -> int:
    now = now or timezone.now()
    ids = list(MakeupCredit.objects.filter(status=M.AVAILABLE, expires_at__lte=now).values_list("pk", flat=True))
    MakeupCredit.objects.filter(pk__in=ids).update(status=M.EXPIRED)
    for pk in ids:
        audit("makeup.expired", target=MakeupCredit(pk=pk))
    return len(ids)


def credit_out(c: MakeupCredit) -> dict:
    o = c.source_booking.occurrence
    return {"id": c.pk, "status": c.status if not (c.status == M.AVAILABLE and c.expires_at <= timezone.now()) else M.EXPIRED,
            "teacher": c.teacher_id, "teacher_name": c.teacher.full_name, "expires_at": c.expires_at.isoformat(),
            "issued_at": c.issued_at.isoformat(), "source_starts_at": o.starts_at.isoformat(), "used_booking": c.used_booking_id}
