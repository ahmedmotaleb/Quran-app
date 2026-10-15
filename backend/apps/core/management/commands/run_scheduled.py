"""Hourly maintenance, run as a Cloud Run Job (see .github/workflows/scheduled.yml). Each step is idempotent and
independent: a failing step is reported and the job exits non-zero, but the other steps still run.

- session_reminders: reminder records for sessions in the next 24 hours
- generate_reviews: due spaced-repetition review tasks
- purge_orphan_media: uploads never attached to a submission/feedback after 48 hours (needs object storage)
"""
import logging

from django.conf import settings
from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError

log = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Run the hourly maintenance steps."

    def handle(self, **_):
        steps = ["session_reminders", "generate_reviews"]
        if settings.MEDIA_STORAGE != "none":
            steps.append("purge_orphan_media")
        failed = []
        for name in steps:
            try:
                call_command(name, stdout=self.stdout)
            except Exception as e:  # noqa: BLE001 — report and continue with the next step
                failed.append(name)
                log.exception("scheduled_step_failed", extra={"step": name})
                self.stderr.write(f"{name} FAILED: {type(e).__name__}")
        if failed:
            raise CommandError(f"Failed steps: {', '.join(failed)}")
        self.stdout.write(self.style.SUCCESS(f"Scheduled run OK: {', '.join(steps)}"))
