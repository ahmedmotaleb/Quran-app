#!/usr/bin/env bash
# Turn on Google Calendar + Google Meet for teachers' sessions. Run in Cloud Shell AFTER creating the OAuth client
# (docs/DEPLOY.md §6e):
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/ahmedmotaleb/Quran-app/main/deploy/gcp-google-calendar.sh)
#
# Asks for the OAuth client ID and secret (the secret is hidden and goes to Secret Manager), generates the key that
# encrypts teachers' Google tokens (Secret Manager, never shown), and updates the app, the admin portal and the
# hourly job. Safe to run again (e.g. to rotate the client secret; ROTATE_KEY=1 also replaces the token key, after
# which every teacher reconnects once).
set -euo pipefail

REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-halqa}"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
[ -n "$PROJECT" ] || { echo "Run: gcloud config set project YOUR_PROJECT_ID   then start again."; exit 1; }
PNUM="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUN_SA="$SERVICE-run@$PROJECT.iam.gserviceaccount.com"
APP_URL="https://$SERVICE-$PNUM.$REGION.run.app"
REDIRECT="$APP_URL/api/v1/integrations/google/callback"

echo "Project: $PROJECT   App: $APP_URL"
echo "The OAuth client must list this Authorized redirect URI exactly:"
echo "  $REDIRECT"
echo
gcloud services enable calendar-json.googleapis.com --project "$PROJECT"

read -rp "OAuth Client ID (ends with .apps.googleusercontent.com): " CID
CID="${CID// /}"
[[ "$CID" == *.apps.googleusercontent.com ]] || { echo "That does not look like an OAuth client ID."; exit 1; }
echo "OAuth Client secret (hidden):"
read -rs CSECRET; echo
[ -n "$CSECRET" ] || { echo "The client secret is required."; exit 1; }

put_secret() {  # name; value from stdin; never echoed
  if gcloud secrets describe "$1" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud secrets versions add "$1" --project "$PROJECT" --data-file=- >/dev/null
  else
    gcloud secrets create "$1" --project "$PROJECT" --replication-policy automatic --data-file=- >/dev/null
  fi
  gcloud secrets add-iam-policy-binding "$1" --project "$PROJECT" --member "serviceAccount:$RUN_SA" \
    --role roles/secretmanager.secretAccessor >/dev/null
}

echo "▸ Storing the client secret in Secret Manager…"
printf '%s' "$CSECRET" | put_secret "$SERVICE-google-client-secret"; unset CSECRET
if ! gcloud secrets describe "$SERVICE-google-token-key" --project "$PROJECT" >/dev/null 2>&1 || [ "${ROTATE_KEY:-0}" = "1" ]; then
  echo "▸ Generating the key that encrypts teachers' Google tokens…"
  python3 -c 'import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode(),end="")' | put_secret "$SERVICE-google-token-key"
else
  echo "▸ Token key already exists; keeping it."
fi

ENVS="GOOGLE_CLIENT_ID=$CID,GOOGLE_REDIRECT_URI=$REDIRECT"
SECRETS="GOOGLE_CLIENT_SECRET=$SERVICE-google-client-secret:latest,GOOGLE_TOKEN_KEY=$SERVICE-google-token-key:latest"
echo "▸ Updating the app, the admin portal and the hourly job…"
gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION" --quiet --update-env-vars "$ENVS" --update-secrets "$SECRETS"
gcloud run services update "$SERVICE-admin" --project "$PROJECT" --region "$REGION" --quiet --update-env-vars "$ENVS" --update-secrets "$SECRETS" >/dev/null 2>&1 \
  || echo "  (admin portal: updated at the next deploy)"
gcloud run jobs update "$SERVICE-tasks" --project "$PROJECT" --region "$REGION" --quiet --update-env-vars "$ENVS" --update-secrets "$SECRETS" >/dev/null 2>&1 \
  || echo "  (hourly job: updated at the next deploy)"

cat <<MSG

✅ Done. A teacher now opens the app → حسابي → «ربط Google Calendar», signs in with their own Google account and
allows only "View and edit events on all your calendars" (calendar.events) and their email address. Then
المواعيد → «إنشاء جلسة»: the Calendar event and the Google Meet are created automatically.

While the OAuth consent screen is in "Testing": add each teacher's Google email under "Test users". Google ends
Testing-mode authorizations after 7 days (teachers would reconnect weekly). See docs/DEPLOY.md §6e for publishing
"In production" (Google verification) or an "Internal" app if the academy uses Google Workspace.
MSG
