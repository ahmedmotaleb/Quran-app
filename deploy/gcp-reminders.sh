#!/usr/bin/env bash
# 15-minute session reminders: the alarm clock (owner request, 14 Nov 2026). Run once in Cloud Shell as the project
# owner:  bash deploy/gcp-reminders.sh
#
# What it does:
# - enables Cloud Tasks and creates the queue «halqa-reminders» (europe-west1). Retries: up to 5 attempts within
#   10 minutes;
# - lets the app's runtime account enqueue tasks (roles/cloudtasks.enqueuer);
# - creates a random secret in Secret Manager («halqa-reminder-task-secret»), never printed, and gives it to the app
#   and the maintenance job together with the queue name and the callback URL.
#
# Cost: Cloud Tasks' free tier is 1 million operations a month. HALQA uses about 2 per booked session (create +
# deliver). The database is woken only when a reminder is due, not every few minutes, which matters on Neon's free
# plan (100 compute-hours a month).
set -euo pipefail

REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-halqa}"
QUEUE="${QUEUE:-halqa-reminders}"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
[ -n "$PROJECT" ] || { echo "Run: gcloud config set project YOUR_PROJECT_ID   then start again."; exit 1; }
RUN_SA="$SERVICE-run@$PROJECT.iam.gserviceaccount.com"
SECRET="$SERVICE-reminder-task-secret"

echo "▸ Cloud Tasks API and queue $QUEUE…"
gcloud services enable cloudtasks.googleapis.com --project "$PROJECT" >/dev/null
if ! gcloud tasks queues describe "$QUEUE" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
  gcloud tasks queues create "$QUEUE" --project "$PROJECT" --location "$REGION" \
    --max-attempts 5 --max-retry-duration 600s --min-backoff 10s --max-backoff 120s >/dev/null
fi
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$RUN_SA" --role roles/cloudtasks.enqueuer \
  --condition None >/dev/null

echo "▸ Callback secret (kept in Secret Manager, not shown)…"
if ! gcloud secrets describe "$SECRET" --project "$PROJECT" >/dev/null 2>&1; then
  python3 -c "import secrets;print(secrets.token_urlsafe(48), end='')" \
    | gcloud secrets create "$SECRET" --project "$PROJECT" --replication-policy automatic --data-file=- >/dev/null
fi
gcloud secrets add-iam-policy-binding "$SECRET" --project "$PROJECT" --member "serviceAccount:$RUN_SA" \
  --role roles/secretmanager.secretAccessor >/dev/null

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
VARS="REMINDER_TASKS_QUEUE=projects/$PROJECT/locations/$REGION/queues/$QUEUE,REMINDER_TASKS_URL=$URL/api/v1/internal/session-reminders"
echo "▸ Updating the app and the maintenance job…"
gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION" --quiet \
  --update-env-vars "$VARS" --update-secrets "REMINDER_TASKS_SECRET=$SECRET:latest" >/dev/null
gcloud run jobs update "$SERVICE-tasks" --project "$PROJECT" --region "$REGION" --quiet \
  --update-env-vars "$VARS" --update-secrets "REMINDER_TASKS_SECRET=$SECRET:latest" >/dev/null 2>&1 \
  || echo "  (the job will get it at the next deploy)"
gcloud run services update "$SERVICE-admin" --project "$PROJECT" --region "$REGION" --quiet \
  --update-env-vars "$VARS" --update-secrets "REMINDER_TASKS_SECRET=$SECRET:latest" >/dev/null 2>&1 \
  || echo "  (the admin portal will get it at the next deploy)"   # admin changes to sessions set alarms too
sleep 8
curl -s "$URL/api/ready" | grep -o '"session_reminders":"[^"]*"' || true
cat <<MSG

"session_reminders" above should say "alarm". From now on every booked session gets a task at 15 minutes before it
(Cloud Console → Cloud Tasks → $QUEUE shows them). The hourly maintenance job re-arms any that are missing.
MSG
