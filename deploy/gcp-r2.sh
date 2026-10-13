#!/usr/bin/env bash
# Connect the Cloud Run service to a private Cloudflare R2 bucket for learner recordings. Run in Cloud Shell:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/ahmedmotaleb/Quran-app/main/deploy/gcp-r2.sh)
#
# Asks for the R2 account ID, bucket, access key ID and secret access key (the secret is hidden and goes to
# Secret Manager, never into the service settings). Safe to run again, e.g. to rotate the key.
set -euo pipefail

REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-halqa}"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
[ -n "$PROJECT" ] || { echo "Run: gcloud config set project YOUR_PROJECT_ID   then start again."; exit 1; }
RUN_SA="$SERVICE-run@$PROJECT.iam.gserviceaccount.com"
SECRET="$SERVICE-storage-secret"

read -rp "Cloudflare account ID (32 letters/digits, R2 overview page): " ACCOUNT
ACCOUNT="${ACCOUNT// /}"
[[ "$ACCOUNT" =~ ^[0-9a-f]{32}$ ]] || { echo "That does not look like a Cloudflare account ID."; exit 1; }
read -rp "Bucket name [halqa-recordings]: " BUCKET
BUCKET="${BUCKET:-halqa-recordings}"
read -rp "Access Key ID: " KEY_ID
KEY_ID="${KEY_ID// /}"
[ -n "$KEY_ID" ] || { echo "Access Key ID is required."; exit 1; }
echo "Secret Access Key (hidden):"
read -rs KEY_SECRET; echo
[ -n "$KEY_SECRET" ] || { echo "Secret Access Key is required."; exit 1; }
ENDPOINT="https://$ACCOUNT.r2.cloudflarestorage.com"

echo "▸ Storing the secret key in Secret Manager…"
if gcloud secrets describe "$SECRET" --project "$PROJECT" >/dev/null 2>&1; then
  printf '%s' "$KEY_SECRET" | gcloud secrets versions add "$SECRET" --project "$PROJECT" --data-file=- >/dev/null
else
  printf '%s' "$KEY_SECRET" | gcloud secrets create "$SECRET" --project "$PROJECT" --replication-policy automatic --data-file=- >/dev/null
fi
unset KEY_SECRET
gcloud secrets add-iam-policy-binding "$SECRET" --project "$PROJECT" --member "serviceAccount:$RUN_SA" \
  --role roles/secretmanager.secretAccessor >/dev/null

echo "▸ Updating the app (a new revision starts in about a minute)…"
gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION" --quiet \
  --update-env-vars "STORAGE_ENDPOINT_URL=$ENDPOINT,STORAGE_BUCKET=$BUCKET,STORAGE_ACCESS_KEY_ID=$KEY_ID,STORAGE_REGION=auto" \
  --update-secrets "STORAGE_SECRET_ACCESS_KEY=$SECRET:latest"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
echo "▸ Checking the bucket from the app…"
sleep 10
curl -s "$URL/api/ready"; echo
cat <<EOF

Above, "media_storage" should say "configured". If it says "error: …", the message names what to fix
(key, bucket name or account ID); run this script again with the right values.
Later deploys from GitHub keep these settings.
EOF
