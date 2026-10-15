#!/usr/bin/env bash
# Connect the Cloud Run service to an SMTP email provider (password resets, welcome links). Run in Cloud Shell:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/ahmedmotaleb/Quran-app/main/deploy/gcp-email.sh)
#
# Works with any SMTP provider (e.g. a transactional-email service's free plan). Verify your sender address or
# domain at the provider first. The SMTP password goes to Secret Manager, never into the service settings.
set -euo pipefail

REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-halqa}"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
[ -n "$PROJECT" ] || { echo "Run: gcloud config set project YOUR_PROJECT_ID   then start again."; exit 1; }
RUN_SA="$SERVICE-run@$PROJECT.iam.gserviceaccount.com"
SECRET="$SERVICE-email-password"

read -rp "SMTP host (e.g. smtp.example.com): " HOST
read -rp "SMTP port [587]: " PORT; PORT="${PORT:-587}"
read -rp "SMTP username: " USERNAME
echo "SMTP password or API key (hidden):"; read -rs PASSWORD; echo
read -rp "Sender address (verified at the provider), e.g. noreply@your-domain: " FROM
[ -n "$HOST" ] && [ -n "$USERNAME" ] && [ -n "$PASSWORD" ] && [[ "$FROM" == *@* ]] || { echo "All fields are required."; exit 1; }

echo "▸ Storing the password in Secret Manager…"
if gcloud secrets describe "$SECRET" --project "$PROJECT" >/dev/null 2>&1; then
  printf '%s' "$PASSWORD" | gcloud secrets versions add "$SECRET" --project "$PROJECT" --data-file=- >/dev/null
else
  printf '%s' "$PASSWORD" | gcloud secrets create "$SECRET" --project "$PROJECT" --replication-policy automatic --data-file=- >/dev/null
fi
unset PASSWORD
gcloud secrets add-iam-policy-binding "$SECRET" --project "$PROJECT" --member "serviceAccount:$RUN_SA" \
  --role roles/secretmanager.secretAccessor >/dev/null

echo "▸ Updating the app…"
gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION" --quiet \
  --update-env-vars "EMAIL_HOST=$HOST,EMAIL_PORT=$PORT,EMAIL_HOST_USER=$USERNAME,DEFAULT_FROM_EMAIL=$FROM,EMAIL_USE_TLS=true" \
  --update-secrets "EMAIL_HOST_PASSWORD=$SECRET:latest"
URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
sleep 8
curl -s "$URL/api/ready" | grep -o '"email":"[^"]*"' || true
cat <<MSG

"email" above should say "smtp". Now test it: open the app → «نسيت كلمة المرور» with your own email address, and
check your inbox (and spam folder). The next deploy also gives the maintenance job these settings.
MSG
