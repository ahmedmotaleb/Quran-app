"""Daily Quran reminders (reading, memorization, review, end of day); idempotent, run hourly by run_scheduled."""
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Send the daily Quran reminders that are due now (safe to repeat)."

    def handle(self, **_):
        import logging

        from apps.notifications.reminders import run

        sent = run()
        logging.getLogger(__name__).info("quran_reminders", extra={"sent": sent})
        self.stdout.write(self.style.SUCCESS(f"Quran reminders sent: {sent}"))
