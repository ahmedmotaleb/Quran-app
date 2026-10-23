"""Sends password-setup emails queued by a large CSV import (status «pending»). Hourly, from run_scheduled; bounded
by count and time so the maintenance job stays short. An account that set a password, or is no longer active, is
skipped and its queue mark cleared."""
import time

from django.core.management.base import BaseCommand

from apps.accounts.models import AccountStatus, User
from apps.accounts.views import send_setup_email


class Command(BaseCommand):
    help = "Send queued password-setup emails (from CSV imports)."

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=150)
        parser.add_argument("--seconds", type=int, default=240)

    def handle(self, *args, limit, seconds, **opts):
        start, sent, failed, cleared = time.monotonic(), 0, 0, 0
        for u in User.objects.filter(setup_email_status="pending").order_by("date_joined")[:limit]:
            if time.monotonic() - start > seconds:
                break
            if u.status != AccountStatus.ACTIVE or not u.is_active or u.has_usable_password():
                User.objects.filter(pk=u.pk).update(setup_email_status="")
                cleared += 1
                continue
            if send_setup_email(u):  # records sent/failed on the account, audited
                sent += 1
            else:
                failed += 1
        left = User.objects.filter(setup_email_status="pending").count()
        self.stdout.write(f"setup emails: sent {sent}, failed {failed}, cleared {cleared}, still queued {left}")
