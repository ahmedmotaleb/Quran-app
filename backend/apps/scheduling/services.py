"""
Booking and occurrence generation. The database is the authority:

book():  inside one transaction —
  1. per-student advisory lock (serialises one student's concurrent requests and retries);
  2. idempotency: the same (student, key) returns the existing booking;
  3. SELECT … FOR UPDATE on the occurrence row (serialises seats for that session);
  4. checks: scheduled, inside the booking window, capacity, no overlap with the student's other bookings;
  5. insert. Partial unique indexes back up steps 2 and 4 if anything slips through.
Confirmations are created with transaction.on_commit, so a failed notification never undoes a booking.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from apps.accounts.models import AccountStatus, Role
from apps.core.exceptions import ApiError
from apps.core.models import AppSettings

from .models import AvailabilityException, AvailabilityRule, Booking, SessionOccurrence


def _lock_student(student_id: int) -> None:
    with connection.cursor() as c:
        c.execute("SELECT pg_advisory_xact_lock(%s, %s)", [7301, student_id])  # 7301 = booking namespace


def book(*, student, occurrence_id: int, idempotency_key: str, assignment=None, note: str = "", now: datetime | None = None,
         makeup_credit_id: int | None = None) -> tuple[Booking, bool]:
    if student.role != Role.STUDENT or student.status != AccountStatus.ACTIVE:
        raise ApiError("not_eligible", "هذا الحساب لا يمكنه حجز الجلسات.", 403)
    if not idempotency_key or len(idempotency_key) > 64:
        raise ApiError("idempotency_key_required", "تعذّر إرسال الطلب. حدّث الصفحة وحاول مرة أخرى.", 400)
    now = now or timezone.now()
    cfg = AppSettings.load()
    with transaction.atomic():
        _lock_student(student.pk)
        existing = Booking.objects.filter(student=student, idempotency_key=idempotency_key).first()
        if existing:
            return existing, False
        try:
            occ = SessionOccurrence.objects.select_for_update(of=("self",)).select_related("teacher__teacher_profile", "circle").get(pk=occurrence_id)
        except SessionOccurrence.DoesNotExist:
            raise ApiError("slot_unavailable", "لم يعد هذا الموعد متاحًا. اختر موعدًا آخر.", 409)
        prof = getattr(occ.teacher, "teacher_profile", None)
        if (occ.status != SessionOccurrence.Status.SCHEDULED or occ.teacher.status != AccountStatus.ACTIVE
                or prof is None or prof.approved_at is None or (occ.circle_id and occ.circle.state != "published")):
            raise ApiError("slot_unavailable", "لم يعد هذا الموعد متاحًا. اختر موعدًا آخر.", 409)
        if occ.starts_at < now + timedelta(minutes=cfg.booking_lead_minutes):
            raise ApiError("too_late", "لا يمكن حجز موعد يبدأ قريبًا جدًا. اختر موعدًا لاحقًا.", 409)
        if occ.starts_at > now + timedelta(days=cfg.booking_horizon_days):
            raise ApiError("too_early", "هذا الموعد خارج فترة الحجز المتاحة حاليًا.", 409)
        if occ.bookings.filter(student=student, status=Booking.Status.CONFIRMED).exists():
            raise ApiError("already_booked", "لديك حجز مؤكد في هذا الموعد بالفعل.", 409)
        from .waitlist import live_offers

        # A seat offered to a waiting student is held for them until the offer expires (waitlist.py).
        held = live_offers(occ.pk, now, exclude_student=student.pk).count()
        if occ.bookings.filter(status=Booking.Status.CONFIRMED).count() + held >= occ.capacity:
            raise ApiError("slot_taken", "لم يعد هذا الموعد متاحًا؛ حجزه طالب آخر قبل قليل. اختر موعدًا آخر.", 409)
        overlap = Booking.objects.filter(
            student=student, status=Booking.Status.CONFIRMED, occurrence__status=SessionOccurrence.Status.SCHEDULED,
            occurrence__starts_at__lt=occ.ends_at, occurrence__ends_at__gt=occ.starts_at,
        ).exists()
        if overlap:
            raise ApiError("student_conflict", "لديك جلسة أخرى في الوقت نفسه.", 409)
        if assignment is not None and assignment.student_id != student.pk:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"assignment": ["مهمة غير صالحة."]})
        try:
            with transaction.atomic():
                b = Booking.objects.create(occurrence=occ, student=student, idempotency_key=idempotency_key, assignment=assignment, note=note[:500])
        except IntegrityError:
            raise ApiError("slot_taken", "لم يعد هذا الموعد متاحًا. اختر موعدًا آخر.", 409)
        if makeup_credit_id is not None:
            from .makeup import use as use_makeup

            use_makeup(student, makeup_credit_id, b, now)
        transaction.on_commit(lambda: _notify_booked(b.pk))
        return b, True


def cancel(*, booking_id: int, by, reason: str = "", now: datetime | None = None) -> Booking:
    now = now or timezone.now()
    cfg = AppSettings.load()
    with transaction.atomic():
        b = Booking.objects.select_for_update().select_related("occurrence").get(pk=booking_id)
        is_owner = b.student_id == by.pk
        is_teacher = b.occurrence.teacher_id == by.pk
        if not (is_owner or is_teacher or by.role == Role.ADMIN):
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        if is_owner and by.role == Role.STUDENT and reason != "rescheduled":
            # Owner decision (23 Oct 2026): students never cancel; they send «طلب اعتذار» (apps/scheduling/excuses.py).
            raise ApiError("excuse_instead", "لا يمكن إلغاء الجلسة. إن لم تستطع الحضور فأرسل «طلب اعتذار».", 403)
        if b.status != Booking.Status.CONFIRMED:
            return b  # idempotent
        if b.occurrence.starts_at <= now:
            raise ApiError("already_started", "لا يمكن إلغاء جلسة بدأت أو انتهت.", 409)
        if is_owner and b.occurrence.starts_at - now < timedelta(hours=cfg.cancel_hours):
            raise ApiError("cancel_window", f"يمكن الإلغاء حتى {cfg.cancel_hours} ساعة قبل الموعد. تواصل مع معلمك.", 409)
        b.status, b.cancelled_at, b.cancelled_by, b.cancel_reason = Booking.Status.CANCELLED, now, by, reason[:200]
        b.save(update_fields=["status", "cancelled_at", "cancelled_by", "cancel_reason", "updated_at"])
        if not is_owner and reason != "rescheduled":
            transaction.on_commit(lambda: _notify_cancelled(b.pk))
        from .makeup import booking_cancelled
        from .waitlist import seat_freed

        booking_cancelled(b, now)  # a cancelled make-up booking gives the credit back
        occ_id = b.occurrence_id
        transaction.on_commit(lambda: seat_freed(occ_id))  # the next person on the waiting list gets the seat
        return b


def reschedule(*, booking_id: int, new_occurrence_id: int, by, idempotency_key: str) -> Booking:
    """Atomic: reserve the new slot and release the old one, or change nothing."""
    with transaction.atomic():
        old = Booking.objects.select_for_update().get(pk=booking_id)
        if old.student_id != by.pk:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        if old.status != Booking.Status.CONFIRMED:
            raise ApiError("not_active", "هذا الحجز غير نشط.", 409)
        cancel(booking_id=old.pk, by=by, reason="rescheduled")
        new, _ = book(student=by, occurrence_id=new_occurrence_id, idempotency_key=idempotency_key, assignment=old.assignment, note=old.note)
        if new.rescheduled_from_id is None:
            new.rescheduled_from = old
            new.save(update_fields=["rescheduled_from"])
            transaction.on_commit(lambda: _notify_teacher(old.pk, "booking_rescheduled", "غيّر طالب موعد جلسته"))
        return new


def _notify_cancelled(booking_id: int) -> None:
    """The teacher or an admin cancelled: tell the student (a student's own cancellation needs no message)."""
    from apps.notifications.services import notify

    b = Booking.objects.select_related("occurrence__teacher", "student").get(pk=booking_id)
    tz = ZoneInfo(b.student.timezone or "Africa/Cairo")
    when = b.occurrence.starts_at.astimezone(tz).strftime("%Y-%m-%d %H:%M")
    notify(b.student, "booking_cancelled", "أُلغيت جلستك", f"مع {b.occurrence.teacher.full_name} · {when}. يمكنك حجز موعد آخر.",
           link="/sessions", dedupe=f"booking:{b.pk}:cancelled", data={"booking": b.pk})


def _notify_teacher(booking_id: int, kind: str, title: str) -> None:
    from apps.notifications.services import notify

    b = Booking.objects.select_related("occurrence__teacher", "student").get(pk=booking_id)
    tz = ZoneInfo(b.occurrence.teacher.timezone or "Africa/Cairo")
    when = b.occurrence.starts_at.astimezone(tz).strftime("%Y-%m-%d %H:%M")
    notify(b.occurrence.teacher, kind, title, f"{b.student.full_name} · {when}", link="/teacher/schedule",
           dedupe=f"booking:{b.pk}:{kind}", data={"booking": b.pk})


def notify_attendance(booking_id: int) -> None:
    """Absence is worth knowing about: the student and their verified guardians are told (once per value)."""
    from apps.accounts.models import GuardianLink, LinkStatus
    from apps.notifications.services import notify

    b = Booking.objects.select_related("occurrence__teacher", "student").get(pk=booking_id)
    if b.attendance not in (Booking.Attendance.ABSENT,):
        return
    tz = ZoneInfo(b.student.timezone or "Africa/Cairo")
    when = b.occurrence.starts_at.astimezone(tz).strftime("%Y-%m-%d %H:%M")
    notify(b.student, "attendance_absent", "سُجّل غيابك عن جلسة", f"مع {b.occurrence.teacher.full_name} · {when}", link="/sessions",
           dedupe=f"booking:{b.pk}:att:{b.attendance}", data={"booking": b.pk})
    for g in GuardianLink.objects.filter(student=b.student, status=LinkStatus.ACTIVE).select_related("guardian"):
        notify(g.guardian, "child_absent", f"غياب {b.student.full_name} عن جلسة", f"مع {b.occurrence.teacher.full_name} · {when}",
               link="/parent", dedupe=f"booking:{b.pk}:att:{b.attendance}:g{g.guardian_id}", data={"booking": b.pk, "child": b.student_id})


def _notify_booked(booking_id: int) -> None:
    from apps.notifications.services import notify

    b = Booking.objects.select_related("occurrence__teacher", "student").get(pk=booking_id)
    tz = ZoneInfo(b.student.timezone)
    when = b.occurrence.starts_at.astimezone(tz).strftime("%Y-%m-%d %H:%M")
    notify(b.student, "booking_confirmed", "تم تأكيد حجزك", f"مع {b.occurrence.teacher.full_name} · {when}", link=f"/sessions/{b.pk}", dedupe=f"booking:{b.pk}:confirmed", data={"booking": b.pk})
    notify(b.occurrence.teacher, "booking_new", "حجز جديد", f"{b.student.full_name} · {when}", link="/teacher/schedule", dedupe=f"booking:{b.pk}:teacher", data={"booking": b.pk})


def cancel_occurrence(*, occurrence_id: int, by, reason: str, now: datetime | None = None) -> tuple[SessionOccurrence, int]:
    """Admin: cancel a whole session. Every confirmed booking is cancelled with the reason and its student is
    notified; bookings and attendance history are kept (nothing is deleted)."""
    now = now or timezone.now()
    with transaction.atomic():
        o = SessionOccurrence.objects.select_for_update().get(pk=occurrence_id)
        if o.status == SessionOccurrence.Status.CANCELLED:
            return o, 0
        if o.starts_at <= now:
            raise ApiError("already_started", "لا يمكن إلغاء جلسة بدأت أو انتهت.", 409)
        ids = list(o.bookings.select_for_update().filter(status=Booking.Status.CONFIRMED).values_list("pk", flat=True))
        Booking.objects.filter(pk__in=ids).update(status=Booking.Status.CANCELLED, cancelled_at=now, cancelled_by=by,
                                                   cancel_reason=reason[:200], updated_at=now)
        o.status = SessionOccurrence.Status.CANCELLED
        o.save(update_fields=["status", "updated_at"])
        for bid in ids:
            transaction.on_commit(lambda bid=bid: _notify_cancelled(bid))
        # A Google-backed session: delete its Calendar event (attendees told) once the cancellation is committed.
        transaction.on_commit(lambda pk=o.pk: _cancel_google(pk))
    return o, len(ids)


def _cancel_google(occurrence_id: int) -> None:
    from apps.integrations.models import GoogleEvent

    if GoogleEvent.objects.filter(occurrence_id=occurrence_id).exists():
        from apps.integrations.sync import cancel_event

        cancel_event(occurrence_id)


# ---- Occurrence generation (Prompt 10) -------------------------------------------------
def _local_slots(rule: AvailabilityRule, day: date):
    """Yield (start, end) aware datetimes for one local date, handling overnight windows and DST."""
    tz = ZoneInfo(rule.timezone)
    start = datetime.combine(day, rule.start_time, tzinfo=tz)
    end_day = day + timedelta(days=1) if rule.end_time <= rule.start_time else day
    window_end = datetime.combine(end_day, rule.end_time, tzinfo=tz)
    step = timedelta(minutes=rule.session_minutes + rule.buffer_minutes)
    length = timedelta(minutes=rule.session_minutes)
    t = start
    while t + length <= window_end:
        # Normalise through UTC so wall-clock times that don't exist (DST gap) are skipped.
        utc = t.astimezone(ZoneInfo("UTC"))
        if utc.astimezone(tz).replace(tzinfo=None) == t.replace(tzinfo=None):
            yield utc, (utc + length)
        t += step


def generate_occurrences(teacher, *, start: date, days: int) -> int:
    """Create missing individual occurrences from the teacher's rules. Safe to run repeatedly."""
    created = 0
    rules = list(AvailabilityRule.objects.filter(teacher=teacher))
    offs = {(e.date) for e in AvailabilityException.objects.filter(teacher=teacher, kind=AvailabilityException.Kind.OFF, start_time__isnull=True)}
    for i in range(days):
        day = start + timedelta(days=i)
        if day in offs:
            continue
        for rule in rules:
            if day.weekday() != rule.weekday or day < rule.valid_from or (rule.valid_until and day > rule.valid_until):
                continue
            for s, e in _local_slots(rule, day):
                # Any existing row wins, including a slot the teacher closed (cancelled) — never resurrect it.
                if SessionOccurrence.objects.filter(teacher=teacher, starts_at=s).exists():
                    continue
                try:
                    with transaction.atomic():
                        SessionOccurrence.objects.create(teacher=teacher, starts_at=s, ends_at=e, source_rule=rule, capacity=1)
                        created += 1
                except IntegrityError:
                    pass  # overlaps an existing session (e.g. a group class) — the exclusion constraint wins
    return created


def local_time(dt: datetime, tz_name: str) -> time:
    return dt.astimezone(ZoneInfo(tz_name)).time()
