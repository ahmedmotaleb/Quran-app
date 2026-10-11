import logging

from django.db import IntegrityError, transaction

from .models import Notification

log = logging.getLogger(__name__)


def notify(recipient, kind: str, title: str, body: str = "", *, link: str = "", dedupe: str) -> Notification | None:
    """Create an in-app notification once per (recipient, dedupe). Failures never break the caller."""
    try:
        with transaction.atomic():
            return Notification.objects.create(recipient=recipient, kind=kind, title=title, body=body[:500], link=link, dedupe_key=dedupe)
    except IntegrityError:
        return None
    except Exception:  # noqa: BLE001
        log.exception("notification_failed", extra={"kind": kind})
        return None
