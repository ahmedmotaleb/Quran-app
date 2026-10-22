"""Read-only evidence for «تذكّر هذا الجهاز» (owner report 23 Oct: the code is asked at every admin sign-in).

For each admin (id only, no emails or names): whether two-step verification is on, trusted devices created / active /
still matching the account (password and authenticator unchanged), how often trust was used to skip the code, and
the password / authenticator events that end trust. Nothing is changed and no token or cookie value is printed.

  python manage.py trusted_devices_report
"""
import json
import logging
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.accounts.models import Role, TrustedDevice, User
from apps.accounts.trusted import marker
from apps.core.models import AuditEvent

log = logging.getLogger("halqa.ops")


class Command(BaseCommand):
    help = "Per-admin trusted-device evidence (read-only)."

    def handle(self, **_):
        now = timezone.now()
        since = now - timedelta(days=30)
        for u in User.objects.filter(role=Role.ADMIN).order_by("pk"):
            devs = list(TrustedDevice.objects.filter(user=u).order_by("created_at"))
            cur = marker(u)
            active = [d for d in devs if d.revoked_at is None and d.expires_at > now]
            ev = AuditEvent.objects.filter(target_type="accounts.user", target_id=str(u.pk), created_at__gte=since)
            count = lambda a: ev.filter(action=a).count()  # noqa: E731
            logins = ev.filter(action="auth.login", data__portal="admin")
            row = {
                "admin": u.pk, "mfa_enabled": u.mfa_enabled,
                "devices_created": len(devs), "devices_active": len(active),
                "devices_active_matching": sum(1 for d in active if d.marker == cur),
                "devices_revoked": sum(1 for d in devs if d.revoked_at),
                "device_labels": [d.label for d in active][:5],
                "last_device_created": devs[-1].created_at.isoformat()[:16] if devs else None,
                "last_device_used": max((d.last_used_at for d in devs if d.last_used_at), default=None),
                "audit_30d": {a: count(a) for a in ("auth.login", "auth.device_trusted", "auth.mfa_trusted_device", "auth.mfa_failed",
                                                     "auth.password_changed", "auth.password_reset", "auth.mfa_enabled",
                                                     "auth.devices_untrusted")},
                "admin_logins_30d": logins.count(),
                "last_admin_login": (logins.order_by("-created_at").values_list("created_at", flat=True).first() or None),
            }
            for k in ("last_device_used", "last_admin_login"):
                row[k] = row[k].isoformat()[:16] if row[k] else None
            log.warning("trusted_devices_report", extra=row)
            self.stdout.write(json.dumps(row, ensure_ascii=False))
