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
        from apps.accounts.models import User
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
                "inactive": sum(1 for s in subs if not s.active),
                "last_failures": dict(Counter(s.last_failure for s in subs if s.last_failure)),
                "oldest": min((s.created_at for s in subs), default=None),
                "newest": max((s.created_at for s in subs), default=None),
            },
            "notifications_7d": {"total": recent.count(),
                                 "to_users_with_a_device": recent.filter(recipient_id__in=with_devices).count(),
                                 # Inbox only (no device turned on), by the recipient's role: counts, no names.
                                 "inbox_only_by_role": dict(Counter(recent.exclude(recipient_id__in=with_devices)
                                                                    .values_list("recipient__role", flat=True)))},
            # Phone delivery of each notice (outbox, since 10 Nov 2026), by recipient role:
            #   sent = accepted by the push service · no_device = inbox only · pref_off · retry/pending · failed · off
            "push_outcome_7d": _outcomes(recent),
            # Active accounts per role, and how many of them have at least one active device.
            "accounts_with_device_by_role": {
                r: {"accounts": User.objects.filter(role=r, is_active=True).count(),
                    "with_device": User.objects.filter(role=r, is_active=True, pk__in=with_devices).count()}
                for r in ("student", "teacher", "parent")},
        }
        # Admin «إرسال إشعار تجريبي» presses (counts only): did the owner's test reach a device?
        from apps.core.models import AuditEvent

        report["admin_tests_7d"] = [
            {"at": e.created_at, "target": e.target_id, **{k: e.data.get(k) for k in ("devices", "sent", "failed")}}
            for e in AuditEvent.objects.filter(action="admin.push_test", created_at__gte=week)[:10]]
        # «إرسال إشعار تجريبي» from «حسابي» (the account's own devices): the account id, how many devices, how many the
        # push service accepted, and whether the phone that pressed it was among them.
        report["self_tests_7d"] = [
            {"at": e.created_at, "user": e.target_id, **{k: e.data.get(k) for k in ("devices", "sent", "failed", "this_device")}}
            for e in AuditEvent.objects.filter(action="push.self_test", created_at__gte=week)[:10]]
        # One line per device (no endpoint or keys): whose it is (account id and role), when it was connected, and
        # its last accepted send / failure — so "accepted but not shown" can be traced to one phone.
        report["device_rows"] = [
            {"user": x.user_id, "role": x.user.role, "family": device_family(x.device), "active": x.active, "created": x.created_at,
             "last_success": x.last_success_at, "last_failure": x.last_failure or None}
            for x in PushSubscription.objects.select_related("user").order_by("-created_at")[:20]]
        log.warning("push_report", extra={"report": json.dumps(report, default=str)})
        self.stdout.write(json.dumps(report, default=str, ensure_ascii=False))


def _outcomes(qs) -> dict:
    from django.db.models import Count

    out: dict = {}
    for row in qs.values("recipient__role", "push_status").annotate(n=Count("id")):
        out.setdefault(row["recipient__role"], {})[row["push_status"] or "before_outbox"] = row["n"]
    return out

