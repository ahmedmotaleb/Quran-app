"""The alarm clock for session reminders: one Google Cloud Tasks task per (session, start time), due at T−15.

When the task fires it POSTs to /api/v1/internal/session-reminders with the shared secret header. That endpoint runs
reminders.send_due(), which re-reads PostgreSQL: a task for a cancelled or moved session simply finds nothing to
send. Task names are derived from the session and its start time, so scheduling twice is a no-op
(409 ALREADY_EXISTS), and a moved session gets a task of its own.

Configuration (deploy/gcp-reminders.sh sets it; nothing is printed):
- REMINDER_TASKS_QUEUE: projects/<project>/locations/<region>/queues/halqa-reminders
- REMINDER_TASKS_URL: https://<service>/api/v1/internal/session-reminders
- REMINDER_TASKS_SECRET: a random secret (Secret Manager), sent as X-Halqa-Task and checked by the endpoint
On Cloud Run the access token comes from the metadata server (the service's own account needs
roles/cloudtasks.enqueuer). Without configuration this does nothing: the reminders then rely on the app's poll and the
hourly job (see reminders.py).
"""
from __future__ import annotations

import base64
import logging
from datetime import datetime

import requests
from django.conf import settings

log = logging.getLogger(__name__)
_META = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"


def configured() -> bool:
    return bool(getattr(settings, "REMINDER_TASKS_QUEUE", "") and getattr(settings, "REMINDER_TASKS_URL", "")
                and getattr(settings, "REMINDER_TASKS_SECRET", ""))


def _token() -> str:
    r = requests.get(_META, headers={"Metadata-Flavor": "Google"}, timeout=3)
    r.raise_for_status()
    return r.json()["access_token"]


def schedule(occurrence_id: int, at: datetime) -> bool:
    """Ask Cloud Tasks to call the reminder endpoint at `at` (UTC). True when the task exists (new or already there)."""
    if not configured():
        return False
    queue = settings.REMINDER_TASKS_QUEUE
    name = f"{queue}/tasks/soon-{occurrence_id}-{int(at.timestamp())}"
    task = {"task": {"name": name, "scheduleTime": at.strftime("%Y-%m-%dT%H:%M:%SZ"), "httpRequest": {
        "httpMethod": "POST", "url": settings.REMINDER_TASKS_URL,
        "headers": {"Content-Type": "application/json", "X-Halqa-Task": settings.REMINDER_TASKS_SECRET},
        "body": base64.b64encode(f'{{"occurrence": {occurrence_id}}}'.encode()).decode()}}}
    try:
        r = requests.post(f"https://cloudtasks.googleapis.com/v2/{queue}/tasks", json=task,
                          headers={"Authorization": f"Bearer {_token()}"}, timeout=5)
        if r.status_code in (200, 409):          # 409: this exact alarm is already set
            log.info("reminder_alarm_set", extra={"occurrence": occurrence_id, "existed": r.status_code == 409})
            return True
        log.warning("reminder_alarm_failed", extra={"occurrence": occurrence_id, "status": r.status_code, "error": r.text[:200]})
    except Exception as e:  # noqa: BLE001 — never break the booking or session change that triggered it
        log.warning("reminder_alarm_failed", extra={"occurrence": occurrence_id, "error": type(e).__name__})
    return False
