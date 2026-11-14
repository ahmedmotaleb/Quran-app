"""15-minute session reminders (owner request, 14 Nov 2026).

What is sent: «الحلقة | تذكير بالجلسة» / «حلقتك هتبدأ بعد 15 دقيقة. استعد للانضمام إلى الجلسة.»
- Sent to every student with a CONFIRMED booking and to the session's teacher, as an in-app notification (kind
  `session_soon`) with Web Push to their devices.
- It uses the notification outbox: push happens after commit, attempts and errors are recorded, and the hourly job
  retries temporary failures.
- Tapping it opens the session (the student's join screen; the teacher's «المواعيد»), where «انضم إلى الجلسة» is.

The schedule is PostgreSQL itself. A reminder is DUE for a session that is SCHEDULED, starts within the next
LEAD (+ a minute of slack) and has not started. Nothing is pre-computed, so there is no stale row to cancel:
- moved: the reminder belongs to the new time. The dedupe key holds the start time, so the old time's key can
  never fire for the new time, and the new time gets its own;
- cancelled or completed: no longer SCHEDULED, nothing is sent;
- each (person, session, start time) is reminded at most once (the unique notification dedupe key).

Who wakes the server at T−15 (no frontend timers):
- `alarm.schedule(occurrence)` creates a one-shot Google Cloud Task for T−15 when a session is created or moved
  (and on each confirmed booking). The task calls POST /api/v1/internal/session-reminders, which runs `send_due()`.
  The database is woken only when a reminder is due, which matters on Neon's free plan.
- A session created or booked less than LEAD before it starts is reminded at once («بعد N دقائق»), never "in the past".
- Safety nets: the app's unread-count poll (every minute while someone has HALQA open) and the hourly job also run
  `send_due()`. A missed alarm is caught as long as the session has not started; after the start nothing is sent.
"""
from __future__ import annotations

import logging
import math
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

log = logging.getLogger(__name__)

LEAD = timedelta(minutes=15)
SLACK = timedelta(seconds=45)           # an alarm a few seconds early still counts as "15 minutes"
TITLE = "الحلقة | تذكير بالجلسة"


def body_for(minutes: int) -> str:
    if minutes >= 14:
        return "حلقتك هتبدأ بعد 15 دقيقة. استعد للانضمام إلى الجلسة."
    if minutes <= 1:
        return "حلقتك تبدأ الآن تقريبًا. انضم إلى الجلسة."
    unit = "دقائق" if minutes <= 10 else "دقيقة"
    return f"حلقتك هتبدأ بعد {minutes} {unit}. استعد للانضمام إلى الجلسة."


def _key(o) -> str:
    return f"session_soon:{o.pk}:{int(o.starts_at.timestamp())}"


def due_occurrences(now=None, occurrence_ids=None):
    from .models import Booking, SessionOccurrence

    now = now or timezone.now()
    qs = SessionOccurrence.objects.filter(status=SessionOccurrence.Status.SCHEDULED, starts_at__gt=now,
                                          starts_at__lte=now + LEAD + SLACK)
    if occurrence_ids is not None:
        qs = qs.filter(pk__in=occurrence_ids)
    return qs.filter(bookings__status=Booking.Status.CONFIRMED).distinct().select_related("teacher")


def send_due(now=None, occurrence_ids=None) -> int:
    """Create the due reminders (idempotent). Returns how many notifications were created."""
    from apps.notifications.services import notify

    from .models import Booking

    now = now or timezone.now()
    made = 0
    for o in due_occurrences(now, occurrence_ids):
        minutes = max(1, math.ceil((o.starts_at - now).total_seconds() / 60))
        body = body_for(minutes)
        bookings = Booking.objects.filter(occurrence=o, status=Booking.Status.CONFIRMED).select_related("student")
        with transaction.atomic():   # the notices and their outbox rows together; push after commit
            for b in bookings:
                made += bool(notify(b.student, "session_soon", TITLE, body, link=f"/sessions/{b.pk}", dedupe=_key(o),
                                    data={"booking": b.pk, "occurrence": o.pk, "starts_at": o.starts_at.isoformat()}))
            made += bool(notify(o.teacher, "session_soon", TITLE, body, link="/teacher/schedule", dedupe=_key(o),
                                data={"occurrence": o.pk, "starts_at": o.starts_at.isoformat()}))
    if made:
        log.info("session_reminders_sent", extra={"count": made})
    return made


def session_changed(o) -> None:
    """A session was created, moved or (re)booked: remind now if it is already within LEAD, else set the alarm.
    Runs after commit (the caller registers it with transaction.on_commit)."""
    from . import alarm

    from .models import SessionOccurrence

    o = SessionOccurrence.objects.filter(pk=o.pk).select_related("teacher").first()
    if o is None or o.status != SessionOccurrence.Status.SCHEDULED or o.starts_at <= timezone.now():
        return
    if o.starts_at - timezone.now() <= LEAD + SLACK:
        send_due(occurrence_ids=[o.pk])
    else:
        alarm.schedule(o.pk, o.starts_at - LEAD)

