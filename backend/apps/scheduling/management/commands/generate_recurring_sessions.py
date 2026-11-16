"""Hourly: every active weekly series keeps its sessions two weeks ahead, with its participants booked (series.py)."""
import json
import logging

from django.core.management.base import BaseCommand

log = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Generate upcoming sessions of the weekly series."

    def handle(self, **_):
        from apps.scheduling.series import run_all

        out = run_all()
        log.info("recurring_sessions", extra={"result": json.dumps(out)})
        self.stdout.write(json.dumps(out))
