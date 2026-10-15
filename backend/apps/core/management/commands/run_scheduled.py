"""Hourly maintenance, run as a Cloud Run Job (see .github/workflows/scheduled.yml). Each step is idempotent and
independent: a failing step is reported and the job exits non-zero, but the other steps still run.

- session_reminders: reminder records for sessions in the next 24 hours
- generate_reviews: due spaced-repetition review tasks
- purge_orphan_media: uploads never attached to a submission/feedback after 48 hours (needs object storage)
- ops_stats: one aggregate log line (database size and connections, stored media, failed uploads) that the
  monitoring log metrics read; it never contains names, emails or object keys
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
        try:
            log.info("ops_stats", extra=ops_stats())
        except Exception:  # noqa: BLE001
            failed.append("ops_stats")
            log.exception("scheduled_step_failed", extra={"step": "ops_stats"})
        if failed:
            raise CommandError(f"Failed steps: {', '.join(failed)}")
        self.stdout.write(self.style.SUCCESS(f"Scheduled run OK: {', '.join(steps)}"))


def ops_stats() -> dict:
    from datetime import timedelta

    from django.db import connection
    from django.db.models import Count, Sum
    from django.utils import timezone

    from apps.media.models import MediaObject

    with connection.cursor() as c:
        c.execute("SELECT pg_database_size(current_database()), (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()),"
                  " current_setting('max_connections')::int")
        size, conns, max_conns = c.fetchone()
    media = MediaObject.objects.aggregate(n=Count("id"), b=Sum("size_bytes"))
    since = timezone.now() - timedelta(hours=24)
    failed = MediaObject.objects.filter(created_at__gte=since, rejection_reason="storage_error").count()
    return {"db_size_mb": round(size / 1048576, 1), "db_connections": conns, "db_max_connections": max_conns,
            "db_connections_pct": round(100 * conns / max(max_conns, 1), 1),
            "media_objects": media["n"], "media_mb": round((media["b"] or 0) / 1048576, 1), "uploads_failed_24h": failed}
