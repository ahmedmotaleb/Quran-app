"""Read-only Web Push diagnosis (Ops task push-report). Prints and logs, without any endpoint, key or personal data:
- configuration: both VAPID keys present, the private key valid and MATCHING the public key browsers subscribe with,
  the subject usable;
- devices: how many subscriptions, by account role and device family, delivered recently, failing;
- reach: recent notifications whose recipient has at least one device.

  python manage.py push_report
"""
import base64
import json
import logging
from collections import Counter
from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand
from django.utils import timezone

log = logging.getLogger("halqa.ops")


def device_family(ua: str) -> str:
    u = (ua or "").lower()
    if "android" in u:
        return "android"
    if "iphone" in u or "ipad" in u:
        return "ios"
    if "edg/" in u:
        return "desktop-edge"
    if "firefox" in u:
        return "desktop-firefox"
    if "chrome" in u:
        return "desktop-chrome"
    if "safari" in u:
        return "desktop-safari"
    return "other"


def key_check() -> dict:
    """Does the private key derive exactly the public key in settings? A mismatch makes every push fail (403)."""
    out = {"public_key_set": bool(settings.VAPID_PUBLIC_KEY), "private_key_set": bool(settings.VAPID_PRIVATE_KEY),
           "subject_ok": str(settings.VAPID_SUBJECT).startswith(("https://", "mailto:"))}
    if not (settings.VAPID_PUBLIC_KEY and settings.VAPID_PRIVATE_KEY):
        out["keys_match"] = False
        return out
    try:
        from cryptography.hazmat.primitives import serialization
        from py_vapid import Vapid

        v = Vapid.from_string(settings.VAPID_PRIVATE_KEY.strip())
        pub = v.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        derived = base64.urlsafe_b64encode(pub).rstrip(b"=").decode()
        out["private_key_valid"] = True
        out["keys_match"] = derived == settings.VAPID_PUBLIC_KEY.strip()
        out["public_key_length_ok"] = len(base64.urlsafe_b64decode(settings.VAPID_PUBLIC_KEY.strip() + "==")) == 65
    except Exception as e:  # noqa: BLE001 — a report never fails on a bad key: it says so
        out["private_key_valid"], out["keys_match"], out["key_error"] = False, False, type(e).__name__
    return out


class Command(BaseCommand):
    help = "Report push configuration and device subscriptions (read-only; no endpoints or keys)."

    def handle(self, **_):
        from apps.notifications.models import Notification, PushSubscription

        now = timezone.now()
        subs = list(PushSubscription.objects.select_related("user"))
        week = now - timedelta(days=7)
        with_devices = {s.user_id for s in subs}
        recent = Notification.objects.filter(created_at__gte=week)
        report = {
            "config": key_check(),
            "devices": {
                "total": len(subs), "users": len(with_devices),
                "by_role": dict(Counter(s.user.role for s in subs)),
                "by_family": dict(Counter(device_family(s.device) for s in subs)),
                "delivered_ever": sum(1 for s in subs if s.last_success_at),
                "delivered_7d": sum(1 for s in subs if s.last_success_at and s.last_success_at >= week),
                "failing": sum(1 for s in subs if s.failures),
                "oldest": min((s.created_at for s in subs), default=None),
                "newest": max((s.created_at for s in subs), default=None),
            },
            "notifications_7d": {"total": recent.count(),
                                 "to_users_with_a_device": recent.filter(recipient_id__in=with_devices).count()},
        }
        log.warning("push_report", extra={"report": json.dumps(report, default=str)})
        self.stdout.write(json.dumps(report, default=str, ensure_ascii=False))
