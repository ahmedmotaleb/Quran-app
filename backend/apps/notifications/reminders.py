"""Daily Quran reminders «تذكيرات القرآن الكريم» (owner request, 4 Nov 2026), sent by the hourly maintenance job.

For each active student with at least one active push device and the «تذكيرات القرآن» preference on:
- the chosen hour is the student's own local hour (`User.timezone`); the job runs hourly, so a reminder goes out at
  the first run within WINDOW hours after it (a missed run catches up; later than that it is skipped for the day);
- nothing inside quiet hours; at most ONE reminder per student per run; each kind at most once per local day
  (the notification dedupe key `reminder:<kind>:<date>` makes repeats impossible, even across concurrent runs);
- only when there is something left to do, checked at send time:
  reading  — skipped once the student opened the Mushaf today (reading position saved today);
  hifz     — only with an open memorization task (not submitted/accepted);
  review   — only with a review task due by the end of today and not done;
  evening  — only for tasks due today that are still not done;
- the lock screen shows a generic text only (push.GENERIC); tapping opens the Mushaf or that task.
Students without a teacher still get the reading reminder (memorization/review need tasks).
"""
from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from django.utils import timezone

WINDOW = 2  # hours after the chosen hour in which a missed reminder is still sent
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


def due_kinds(s, local: datetime) -> list[str]:
    """Kinds whose hour has come (within WINDOW) and that are on, outside quiet hours; earliest hour first."""
    h = local.hour
    out = []
    for k in s.KINDS:
        hour = getattr(s, f"{k}_hour")
        if getattr(s, f"{k}_on") and (h - hour) % 24 < WINDOW and not s.in_quiet(h):
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
            w = what(u, kind, local)
            if w is None:
                continue
            title, body = TEXT[kind]
            if notify(u, f"reminder_{kind}", title, body, link=w["link"], dedupe=key, data=w["data"]):
                sent[kind] += 1
            break  # at most one reminder per student per run
    return sent

