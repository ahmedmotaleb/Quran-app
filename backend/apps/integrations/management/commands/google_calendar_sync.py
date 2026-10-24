"""Hourly (run_scheduled): finish Google-backed sessions still waiting for their event or Meet, complete
cancellations Google did not accept, and keep invite lists in step with circle membership."""
from django.core.management.base import BaseCommand

from apps.integrations import google
from apps.integrations.sync import run_due


class Command(BaseCommand):
    help = "Google Calendar + Meet: retries and attendee updates."

    def handle(self, *args, **opts):
        if not google.configured():
            self.stdout.write("google calendar: not configured")
            return
        self.stdout.write(f"google calendar: {run_due()}")
