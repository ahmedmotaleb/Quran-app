#!/usr/bin/env bash
# Turn on «المتابعة باستخدام Google / Microsoft / Apple» on the Cloud Run service. Run in Cloud Shell:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/ahmedmotaleb/Quran-app/main/deploy/gcp-social-login.sh)
#
# It asks, provider by provider (press Enter to skip one), for the client id and secret you created in that
# provider's console (docs/AUTH.md explains each step). Secrets are typed hidden and stored in Secret Manager; only
# public ids go into the service settings. Safe to run again (to add a provider or rotate a secret).
set -euo pipefail

REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-halqa}"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
[ -n "$PROJECT" ] || { echo "Run: gcloud config set project YOUR_PROJECT_ID   then start again."; exit 1; }
RUN_SA="$SERVICE-run@$PROJECT.iam.gserviceaccount.com"
URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format="value(status.url)")"
APP_URL_SET="$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json | grep -A1 '"APP_URL"' | grep -o 'https://[^"]*' || true)"
BASE="${APP_URL_SET:-$URL}"
ENVS=(); SECRETS=()

put_secret() {  # name value
  if gcloud secrets describe "$1" --project "$PROJECT" >/dev/null 2>&1; then
    printf '%s' "$2" | gcloud secrets versions add "$1" --project "$PROJECT" --data-file=- >/dev/null
  else
    printf '%s' "$2" | gcloud secrets create "$1" --project "$PROJECT" --replication-policy automatic --data-file=- >/dev/null
  fi
  gcloud secrets add-iam-policy-binding "$1" --project "$PROJECT" --member "serviceAccount:$RUN_SA" --role roles/secretmanager.secretAccessor >/dev/null
}

echo "Callback addresses to register with each provider (exactly):"
for p in google microsoft apple; do echo "  $p:  $BASE/api/v1/auth/oauth/$p/callback"; done
echo

read -rp "Google OAuth client ID (Enter to skip): " G_ID
if [ -n "${G_ID// /}" ]; then
  echo "Google client secret (hidden):"; read -rs G_SECRET; echo
  [ -n "$G_SECRET" ] || { echo "The secret is required."; exit 1; }
  put_secret "$SERVICE-auth-google-secret" "$G_SECRET"; unset G_SECRET
  ENVS+=("AUTH_GOOGLE_CLIENT_ID=${G_ID// /}"); SECRETS+=("AUTH_GOOGLE_CLIENT_SECRET=$SERVICE-auth-google-secret:latest")
fi

read -rp "Microsoft application (client) ID (Enter to skip): " M_ID
if [ -n "${M_ID// /}" ]; then
  echo "Microsoft client secret VALUE (hidden):"; read -rs M_SECRET; echo
  [ -n "$M_SECRET" ] || { echo "The secret is required."; exit 1; }
  read -rp "Tenant [common = personal + work accounts]: " M_TENANT
  put_secret "$SERVICE-auth-microsoft-secret" "$M_SECRET"; unset M_SECRET
  ENVS+=("AUTH_MICROSOFT_CLIENT_ID=${M_ID// /}" "AUTH_MICROSOFT_TENANT=${M_TENANT:-common}")
  SECRETS+=("AUTH_MICROSOFT_CLIENT_SECRET=$SERVICE-auth-microsoft-secret:latest")
fi

read -rp "Apple Services ID (e.g. app.halqa.web; Enter to skip): " A_ID
if [ -n "${A_ID// /}" ]; then
  read -rp "Apple Team ID: " A_TEAM; read -rp "Apple Key ID: " A_KEY
  read -rp "Path to the .p8 key file (upload it to Cloud Shell first): " A_P8
  [ -f "$A_P8" ] || { echo "File not found: $A_P8"; exit 1; }
  put_secret "$SERVICE-auth-apple-key" "$(cat "$A_P8")"
  ENVS+=("AUTH_APPLE_CLIENT_ID=${A_ID// /}" "AUTH_APPLE_TEAM_ID=${A_TEAM// /}" "AUTH_APPLE_KEY_ID=${A_KEY// /}")
  SECRETS+=("AUTH_APPLE_PRIVATE_KEY=$SERVICE-auth-apple-key:latest")
fi

[ ${#ENVS[@]} -gt 0 ] || { echo "Nothing entered; nothing changed."; exit 0; }
echo "▸ Updating the app (a new revision starts in about a minute)…"
gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION" --quiet --update-env-vars "$(IFS=,; echo "${ENVS[*]}")" \
  --update-secrets "$(IFS=,; echo "${SECRETS[*]}")" >/dev/null
sleep 10
echo "▸ Sign-in buttons the app now offers:"
curl -s "$BASE/api/v1/auth/oauth/providers"; echo
cat <<EOF

Open $BASE on a phone and use «المتابعة باستخدام …» on the sign-in screen. Until each provider has been tried on a
real device (docs/AUTH.md checklist), treat it as configured, not yet verified.
EOF
