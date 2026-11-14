"""Create reminder notifications for sessions starting in the next 24 hours (idempotent; run hourly from a
scheduler). They are also created when a user opens the app.

Also the safety net of the 15-minute reminders (apps/scheduling/reminders.py): sends any that are due, and re-arms
the T−15 alarm of every booked session in the next 2 hours. Alarms are named per session and start time, so this
is idempotent, and an alarm that failed to be created earlier is created now, before it is needed."""
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

        from apps.scheduling import alarm
        from apps.scheduling.models import SessionOccurrence
        from apps.scheduling.reminders import LEAD, send_due

        soon_made = send_due(now)
        armed = 0
        if alarm.configured():
            upcoming = (SessionOccurrence.objects.filter(status="scheduled", starts_at__gt=now + LEAD, starts_at__lte=now + timedelta(hours=2),
                                                         bookings__status="confirmed").distinct().values_list("pk", "starts_at"))
            armed = sum(alarm.schedule(pk, st - LEAD) for pk, st in upcoming)
        self.stdout.write(self.style.SUCCESS(f"15-minute reminders sent: {soon_made}; alarms (re)armed: {armed}"))
