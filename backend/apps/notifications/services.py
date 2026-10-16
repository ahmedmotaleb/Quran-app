import logging

from django.db import IntegrityError, transaction

from .models import Notification

log = logging.getLogger(__name__)


def notify(recipient, kind: str, title: str, body: str = "", *, link: str = "", dedupe: str, data: dict | None = None) -> Notification | None:
    """Create an in-app notification once per (recipient, dedupe). Call it after commit (transaction.on_commit) so a
    failed notification can never roll back the booking/grade that caused it. Failures never break the caller."""
    try:
        with transaction.atomic():
            n = Notification.objects.create(recipient=recipient, kind=kind, title=title, body=body[:500], link=link,
                                            dedupe_key=dedupe, data=data or {})
    except IntegrityError:
        return None
    except Exception:  # noqa: BLE001
        log.exception("notification_failed", extra={"kind": kind})
        return None
    from .push import deliver

    deliver(n)  # optional phone delivery; generic text only, never raises
    return n


def after_commit(recipient, kind: str, title: str, body: str = "", **kw) -> None:
    transaction.on_commit(lambda: notify(recipient, kind, title, body, **kw))


def ensure_session_reminders(user) -> int:
    """Reminder records for the user's confirmed sessions starting within the next 24 hours (once per booking).
    Created lazily when the user checks notifications, and by the `session_reminders` command."""
    from datetime import timedelta
    from zoneinfo import ZoneInfo

    from django.utils import timezone

    from apps.core.models import AppSettings
    from apps.scheduling.models import Booking

    if not AppSettings.load().session_reminders:
        return 0
    now = timezone.now()
    qs = Booking.objects.filter(status=Booking.Status.CONFIRMED, occurrence__starts_at__gt=now,
                                occurrence__starts_at__lte=now + timedelta(hours=24)).select_related("occurrence__teacher", "student")
    qs = qs.filter(student=user) if user.role == "student" else qs.filter(occurrence__teacher=user) if user.role == "teacher" else qs.none()
    made = 0
    for b in qs:
        tz = ZoneInfo(user.timezone or "Africa/Cairo")
        when = b.occurrence.starts_at.astimezone(tz).strftime("%Y-%m-%d %H:%M")
        other = b.occurrence.teacher.full_name if user.role == "student" else b.student.full_name
        made += bool(notify(user, "session_reminder", "تذكير بجلسة قادمة", f"مع {other} · {when}", link="/sessions",
                            dedupe=f"booking:{b.pk}:reminder", data={"booking": b.pk}))
    return made
