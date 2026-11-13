"""Hourly: scheduled adhkar reminders (apps.adhkar.services.run)."""
import json
import logging

from django.core.management.base import BaseCommand

log = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Send due adhkar reminders (morning/evening/sleep and the periodic ones)."

    def handle(self, **_):
        from apps.adhkar.services import run

        out = run()
        log.info("adhkar_reminders", extra={"result": json.dumps(out)})
        self.stdout.write(json.dumps(out))
