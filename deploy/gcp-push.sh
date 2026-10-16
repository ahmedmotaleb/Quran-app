#!/usr/bin/env bash
# Turn on phone notifications (Web Push) for the Cloud Run app. Run once in Cloud Shell:
#
#   bash deploy/gcp-push.sh
#
# Web Push needs no outside account: this generates the app's own signing keys (VAPID). The private key goes to
# Secret Manager; the public key is a normal setting (browsers need it). Re-running keeps the existing keys unless
# you pass ROTATE=1 — rotating makes every device subscribe again.
set -euo pipefail

REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-halqa}"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
[ -n "$PROJECT" ] || { echo "Run: gcloud config set project YOUR_PROJECT_ID   then start again."; exit 1; }
RUN_SA="$SERVICE-run@$PROJECT.iam.gserviceaccount.com"
SECRET="$SERVICE-vapid-private"

if gcloud secrets describe "$SECRET" --project "$PROJECT" >/dev/null 2>&1 && [ "${ROTATE:-0}" != "1" ]; then
  PUB="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format json \
    | python3 -c "import json,sys;print(next((e['value'] for c in json.load(sys.stdin)['spec']['template']['spec']['containers'] for e in c.get('env',[]) if e['name']=='VAPID_PUBLIC_KEY'),''))")"
  [ -n "$PUB" ] || { echo "The private key exists but the service has no VAPID_PUBLIC_KEY. Run again with ROTATE=1."; exit 1; }
  echo "▸ Keys already exist; keeping them."
else
  echo "▸ Generating the app's push signing keys (P-256)…"
  python3 -c "import cryptography" 2>/dev/null || pip3 install --user -q cryptography
  KEYS="$(python3 - <<'PY'
import base64
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
k = ec.generate_private_key(ec.SECP256R1())
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
priv = b64(k.private_numbers().private_value.to_bytes(32, "big"))
pub = b64(k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))
print(pub, priv)
PY
)"
  PUB="${KEYS% *}"; PRIV="${KEYS#* }"; unset KEYS
  if gcloud secrets describe "$SECRET" --project "$PROJECT" >/dev/null 2>&1; then
    printf '%s' "$PRIV" | gcloud secrets versions add "$SECRET" --project "$PROJECT" --data-file=- >/dev/null
  else
    printf '%s' "$PRIV" | gcloud secrets create "$SECRET" --project "$PROJECT" --replication-policy automatic --data-file=- >/dev/null
  fi
  unset PRIV
  gcloud secrets add-iam-policy-binding "$SECRET" --project "$PROJECT" --member "serviceAccount:$RUN_SA" \
    --role roles/secretmanager.secretAccessor >/dev/null
fi

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
echo "▸ Updating the app and the maintenance job (reminders are sent from the job)…"
gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION" --quiet \
  --update-env-vars "VAPID_PUBLIC_KEY=$PUB,VAPID_SUBJECT=$URL" --update-secrets "VAPID_PRIVATE_KEY=$SECRET:latest"
gcloud run jobs update "$SERVICE-tasks" --project "$PROJECT" --region "$REGION" --quiet \
  --update-env-vars "VAPID_PUBLIC_KEY=$PUB,VAPID_SUBJECT=$URL" --update-secrets "VAPID_PRIVATE_KEY=$SECRET:latest" >/dev/null 2>&1 \
  || echo "  (the job will get the keys at the next deploy)"
sleep 8
curl -s "$URL/api/ready" | grep -o '"push":"[^"]*"' || true
cat <<MSG

"push" above should say "configured". On your phone: open the installed app → حسابي → «إشعارات على هذا الجهاز»
→ turn it on and allow. Then ask a teacher to send you feedback (or book a session): a short, generic
notification should arrive, and tapping it opens the app. On iPhone the app must be installed (iOS 16.4+).
MSG
