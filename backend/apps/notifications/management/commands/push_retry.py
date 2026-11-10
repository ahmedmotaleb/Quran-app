"""Hourly: send notices left `pending` and retry temporary push failures (bounded; see push.retry_pending)."""
import json
import logging

from django.core.management.base import BaseCommand

log = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Send pending and retry temporarily failed phone notifications."

    def handle(self, **_):
        from apps.notifications.push import retry_pending

        out = retry_pending()
        log.info("push_retry", extra={"result": json.dumps(out)})
        self.stdout.write(json.dumps(out))
