"""Attendance by joining (owner request, 22 Nov 2026): when a booked student taps «انضم إلى الجلسة» and gets the
meeting link (bookings/<id>/join, inside the join window), HALQA records their attendance and tells the teacher.

- Before the start or within LATE_AFTER of it: «حاضر»; later: «متأخر».
- Only when the attendance is still empty: a mark the teacher already made is never overwritten, and joining again
  changes nothing (one mark, one notice). The teacher can still correct it from «المواعيد» (audited as before).
- `attendance_marked_by` is the student themself, so the teacher sees it was recorded on joining.
- What HALQA can know is that the student opened the session's link from the app; it cannot see inside Meet / Zoom.
"""
from __future__ import annotations

from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from apps.core.audit import audit
from apps.core.timefmt import time_of

from .models import Booking

LATE_AFTER = timedelta(minutes=10)


def check_in(booking_id: int, request=None) -> str | None:
    """Record the joining student's attendance. Returns the value recorded, or None when one was already there."""
    from apps.notifications.services import after_commit

    from . import excuses

    now = timezone.now()
    with transaction.atomic():
        b = Booking.objects.select_for_update(of=("self",)).select_related("occurrence__teacher", "student").get(pk=booking_id)
        if b.attendance or b.status != Booking.Status.CONFIRMED:
            return None
        o = b.occurrence
        value = Booking.Attendance.LATE if now > o.starts_at + LATE_AFTER else Booking.Attendance.PRESENT
        excuses.mark_attendance(b, value, b.student)          # same path as the teacher's mark (absence rule recount)
        audit("booking.attendance_on_join", actor=b.student, target=b, request=request, value=value)
        word = "حضر" if value == Booking.Attendance.PRESENT else "حضر متأخرًا"
        after_commit(o.teacher, "attendance_joined", f"{word}: {b.student.full_name}",
                     f"انضم إلى جلسة {time_of(o.starts_at, o.teacher.timezone)}" + (f" · {o.title}" if o.title else ""),
                     link="/teacher/schedule", dedupe=f"booking:{b.pk}:joined", data={"booking": b.pk, "occurrence": o.pk, "attendance": value})
    return value
