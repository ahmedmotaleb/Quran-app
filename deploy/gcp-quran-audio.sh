#!/usr/bin/env bash
# Connect ayah audio to the licensed source: Quran Foundation Content API (Quran.com). Run in Cloud Shell:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/ahmedmotaleb/Quran-app/main/deploy/gcp-quran-audio.sh)
#
# Needs a "Backend/server app" from https://dev-console.quran.foundation/projects (client_id + client_secret).
# The secret goes to Secret Manager, never into the service settings or this terminal's history.
# Pre-live keys serve Al-Fatihah and Al-Baqarah only; after Quran Foundation approves production, run this again
# with the production keys and answer "production".
set -euo pipefail

REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-halqa}"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
[ -n "$PROJECT" ] || { echo "Run: gcloud config set project YOUR_PROJECT_ID   then start again."; exit 1; }
RUN_SA="$SERVICE-run@$PROJECT.iam.gserviceaccount.com"
SECRET="$SERVICE-qf-client-secret"

read -rp "Quran Foundation client_id: " CID
echo "Quran Foundation client_secret (hidden):"; read -rs CSECRET; echo
read -rp "Environment [prelive/production] (prelive): " QENV; QENV="${QENV:-prelive}"
[ -n "$CID" ] && [ -n "$CSECRET" ] || { echo "Both the client_id and the client_secret are required."; exit 1; }
[[ "$QENV" == "prelive" || "$QENV" == "production" ]] || { echo "Environment must be prelive or production."; exit 1; }

echo "▸ Checking the keys with Quran Foundation…"
OAUTH="https://prelive-oauth2.quran.foundation"; [ "$QENV" = production ] && OAUTH="https://oauth2.quran.foundation"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -u "$CID:$CSECRET" -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials&scope=content' "$OAUTH/oauth2/token" || true)
[ "$CODE" = 200 ] || { echo "Quran Foundation refused these keys for $QENV (HTTP $CODE). Check the client_id, secret and environment."; exit 1; }

echo "▸ Storing the secret in Secret Manager…"
if gcloud secrets describe "$SECRET" --project "$PROJECT" >/dev/null 2>&1; then
  printf '%s' "$CSECRET" | gcloud secrets versions add "$SECRET" --project "$PROJECT" --data-file=- >/dev/null
else
  printf '%s' "$CSECRET" | gcloud secrets create "$SECRET" --project "$PROJECT" --replication-policy automatic --data-file=- >/dev/null
fi
unset CSECRET
gcloud secrets add-iam-policy-binding "$SECRET" --project "$PROJECT" --member "serviceAccount:$RUN_SA" \
  --role roles/secretmanager.secretAccessor >/dev/null

echo "▸ Updating the app…"
gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION" --quiet \
  --update-env-vars "QF_CLIENT_ID=$CID,QF_ENV=$QENV" --update-secrets "QF_CLIENT_SECRET=$SECRET:latest"
URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
sleep 8
curl -s "$URL/api/ready" | grep -o '"ayah_audio":"[^"]*"' || true
cat <<MSG

"ayah_audio" above should say "quran_foundation_$QENV". Open the Mushaf, go to Al-Fatihah or Al-Baqarah and press
«تشغيل النطاق».$( [ "$QENV" = prelive ] && printf '\nPre-live serves only those two surahs. Ask Quran Foundation for production access in the Developer Console,\nthen run this script again with the production keys.' )
MSG
