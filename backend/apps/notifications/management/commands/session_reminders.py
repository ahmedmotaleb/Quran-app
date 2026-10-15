"""Create reminder notifications for sessions starting in the next 24 hours (idempotent; run hourly from a
scheduler). They are also created when a user opens the app."""
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.accounts.models import User
from apps.notifications.services import ensure_session_reminders
from apps.scheduling.models import Booking


class Command(BaseCommand):
    help = "Create due session reminders (safe to repeat)."

    def handle(self, **_):
        now = timezone.now()
        soon = Booking.objects.filter(status="confirmed", occurrence__starts_at__gt=now, occurrence__starts_at__lte=now + timedelta(hours=24))
        ids = set(soon.values_list("student_id", flat=True)) | set(soon.values_list("occurrence__teacher_id", flat=True))
        made = sum(ensure_session_reminders(u) for u in User.objects.filter(pk__in=ids))
        self.stdout.write(self.style.SUCCESS(f"Reminders created: {made}"))
