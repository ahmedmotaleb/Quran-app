"""Synthetic failures for the monitoring drill (pack prompt 26). Writes one log line per monitored failure event,
marked synthetic=true, exactly as the real code paths would; nothing else happens (no data is changed, no request
fails). Run it in production as the maintenance job with other arguments:

    gcloud run jobs execute halqa-tasks --region europe-west1 --args manage.py,emit_test_alert --wait

Each alert policy that watches these events should then notify within a few minutes.
"""
import logging

from django.core.management.base import BaseCommand

log = logging.getLogger("halqa.synthetic")

EVENTS = [
    ("error", "media_store_failed", {"purpose": "recitation", "error": "SyntheticError", "bytes": 0}),
    ("error", "ready_check_failed", {"checks": {"database": "unavailable: synthetic"}}),
    ("error", "scheduled_step_failed", {"step": "synthetic"}),
    ("error", "recovery_email_failed", {"error": "SyntheticError"}),
    ("error", "unhandled_error", {"view": "Synthetic"}),
    ("warning", "auth_locked", {"minutes": 0}),
]


class Command(BaseCommand):
    help = "Log one synthetic event per monitored failure path."

    def handle(self, **_):
        for level, msg, extra in EVENTS:
            getattr(log, level)(msg, extra={**extra, "synthetic": True})
        self.stdout.write(f"Logged {len(EVENTS)} synthetic events: {', '.join(m for _, m, _ in EVENTS)}")
