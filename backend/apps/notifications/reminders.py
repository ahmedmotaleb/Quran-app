"""Daily Quran reminders «تذكيرات القرآن الكريم» (owner request, 4 Nov 2026), sent by the hourly maintenance job.

For each active student with at least one active push device and the «تذكيرات القرآن» preference on:
- the chosen hour is the student's own local wall-clock hour (`User.timezone`, which follows the device, so a
  traveller keeps "8 PM" where they are). Today's moment is computed in that IANA zone (Cairo's daylight saving
  time included; an hour skipped by a spring-forward change is sent at the first real moment after it). The job runs
  hourly: a reminder goes out at the first run at or after that moment and is caught up later the same local day
  (a missed run, a flight to a zone where the hour already passed), until the quiet hours start;
- no catch-up for a moment that passed before the student changed the settings (changing the hour never fires a
  reminder at once); it starts the next day;
- nothing inside quiet hours; at most ONE reminder per student per run; each kind at most once per local day
  (the notification dedupe key `reminder:<kind>:<date>` makes repeats impossible, even across concurrent runs or
  an hour repeated by a fall-back change), and never twice within MIN_GAP hours (a time-zone change that starts a
  new local date sooner, e.g. crossing the date line, cannot send the same reminder again);
- only when there is something left to do, checked at send time:
  reading  — skipped once the student opened the Mushaf today (reading position saved today);
  hifz     — only with an open memorization task (not submitted/accepted);
  review   — only with a review task due by the end of today and not done;
  evening  — only for tasks due today that are still not done;
- the lock screen shows a generic text only (push.GENERIC); tapping opens the Mushaf or that task.
Students without a teacher still get the reading reminder (memorization/review need tasks).
"""
from __future__ import annotations

from datetime import datetime, time, timedelta
from datetime import timezone as dt_timezone
from zoneinfo import ZoneInfo

from django.utils import timezone

MIN_GAP = 12  # hours: never the same kind twice within this
OPEN = ("not_started", "in_progress", "needs_repeat")
TEXT = {
    "reading": ("وردك اليومي", "حان وقت وردك من القرآن الكريم."),
    "hifz": ("الحفظ اليومي", "حان وقت الحفظ: لديك مقطع لم تُكمله بعد."),
    "review": ("المراجعة اليومية", "لديك مراجعة مستحقة اليوم."),
    "evening": ("قبل نهاية اليوم", "لديك مهام لم تكتمل اليوم."),
}


def settings_for(user):
    from .models import ReminderSettings

    return getattr(user, "reminders", None) or ReminderSettings(user=user)  # defaults until the student changes them


def local_now(user, now=None) -> datetime:
    try:
        tz = ZoneInfo(user.timezone or "Africa/Cairo")
    except Exception:  # noqa: BLE001 — an unknown zone falls back to the academy's
        tz = ZoneInfo("Africa/Cairo")
    return (now or timezone.now()).astimezone(tz)


def due_at(local: datetime, hour: int) -> datetime:
    """Today's moment for that local hour, in the student's zone. A wall time that does not exist (skipped by a
    spring-forward change) resolves to the transition moment; a repeated one (fall-back) to its first occurrence."""
    wall = datetime.combine(local.date(), time(hour), tzinfo=local.tzinfo)
    return wall.astimezone(dt_timezone.utc).astimezone(local.tzinfo)


def due_kinds(s, local: datetime) -> list[str]:
    """Kinds that are on and whose moment today has come, outside quiet hours; earliest hour first."""
    if s.in_quiet(local.hour):
        return []
    changed = s.updated_at if s.pk else None
    out = []
    for k in s.KINDS:
        hour = getattr(s, f"{k}_hour")
        at = due_at(local, hour)
        if getattr(s, f"{k}_on") and local >= at and not (changed and changed > at):
            out.append((hour, k))
    return [k for _, k in sorted(out)]


def what(user, kind: str, local: datetime) -> dict | None:
    """What to send for this kind now, or None when there is nothing left to do."""
    from apps.learning.models import Assignment
    from apps.quran.models import ReadingPosition

    day_start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    day_end = day_start + timedelta(days=1)
    tasks = Assignment.objects.filter(student=user, status__in=OPEN)
    if kind == "reading":
        pos = ReadingPosition.objects.filter(user=user, updated_at__gte=day_start).exists()
        return None if pos else {"link": "/mushaf", "data": {"screen": "mushaf"}}
    if kind == "hifz":
        t = tasks.filter(kind="hifz").order_by("due_at").first()
    elif kind == "review":
        t = tasks.filter(kind="review", due_at__lt=day_end).order_by("due_at").first()
    else:  # evening: due today, not done
        t = tasks.filter(due_at__gte=day_start, due_at__lt=day_end).order_by("due_at").first()
    return None if t is None else {"link": f"/tasks/{t.pk}", "data": {"assignment": t.pk}}


def run(now=None) -> dict:
    from apps.accounts.models import AccountStatus, Role, User

    from .models import Notification
    from .push import wanted
    from .services import notify

    now = now or timezone.now()
    students = (User.objects.filter(role=Role.STUDENT, status=AccountStatus.ACTIVE, is_active=True, push_subscriptions__active=True)
                .distinct().select_related("reminders"))
    sent = {k: 0 for k in TEXT}
    for u in students:
        if not wanted(u, "reminder_reading"):  # «تذكيرات القرآن» switched off in «الإشعارات»
            continue
        s = settings_for(u)
        local = local_now(u, now)
        for kind in due_kinds(s, local):
            key = f"reminder:{kind}:{local.date().isoformat()}"
            if Notification.objects.filter(recipient=u, dedupe_key=key).exists():
                continue
            if Notification.objects.filter(recipient=u, kind=f"reminder_{kind}", created_at__gt=now - timedelta(hours=MIN_GAP)).exists():
                continue
            w = what(u, kind, local)
            if w is None:
                continue
            title, body = TEXT[kind]
            if notify(u, f"reminder_{kind}", title, body, link=w["link"], dedupe=key, data=w["data"]):
                sent[kind] += 1
            break  # at most one reminder per student per run
    return sent

