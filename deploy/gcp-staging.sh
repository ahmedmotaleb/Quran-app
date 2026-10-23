#!/usr/bin/env bash
# One-time setup of the STAGING environment (PROMPT 47): dev → staging → production. Run in Cloud Shell after
# deploy/gcp-setup.sh has set up production:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/ahmedmotaleb/Quran-app/main/deploy/gcp-staging.sh)
#
# Staging is separate from production in everything that holds data or secrets:
#   - its own Cloud Run services (halqa-staging, halqa-staging-admin), scaled to zero when idle;
#   - its own runtime service account, which can read ONLY the staging secrets (never production's database URL,
#     Django key or storage key);
#   - its own empty database (asked for; refused if it is the production database);
#   - optionally its own R2 bucket with its own access key (asked for; refused if it is the production bucket);
#   - no email provider and no push keys (invitation links are shown on screen instead of being emailed).
# It never copies production data. Safe to run again (e.g. to rotate a secret).
set -euo pipefail

REGION="${REGION:-europe-west1}"
PROD="${PROD:-halqa}"
SERVICE="$PROD-staging"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
[ -n "$PROJECT" ] || { echo "Run: gcloud config set project YOUR_PROJECT_ID   then start again."; exit 1; }
PNUM="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUN_SA="$SERVICE-run@$PROJECT.iam.gserviceaccount.com"
DEPLOY_SA="$PROD-deploy@$PROJECT.iam.gserviceaccount.com"
gcloud iam service-accounts describe "$DEPLOY_SA" --project "$PROJECT" >/dev/null 2>&1 \
  || { echo "Production is not set up yet (no $DEPLOY_SA). Run deploy/gcp-setup.sh first."; exit 1; }
echo "Project: $PROJECT   Region: $REGION   Staging services: $SERVICE, $SERVICE-admin"

put_secret() {  # name, value from stdin; never echoed
  if gcloud secrets describe "$1" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud secrets versions add "$1" --project "$PROJECT" --data-file=- >/dev/null
  else
    gcloud secrets create "$1" --project "$PROJECT" --replication-policy automatic --data-file=- >/dev/null
  fi
  gcloud secrets add-iam-policy-binding "$1" --project "$PROJECT" --member "serviceAccount:$RUN_SA" \
    --role roles/secretmanager.secretAccessor >/dev/null
}
host_db() { python3 -c 'import sys,urllib.parse as u;p=u.urlparse(sys.stdin.read().strip());print((p.hostname or "").replace("-pooler","")+"/"+p.path.lstrip("/"))'; }

echo "▸ Staging runtime service account (reads staging secrets only)…"
gcloud iam service-accounts describe "$RUN_SA" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$SERVICE-run" --project "$PROJECT" --display-name "الحلقة staging runtime"
gcloud iam service-accounts add-iam-policy-binding "$RUN_SA" --project "$PROJECT" \
  --member "serviceAccount:$DEPLOY_SA" --role roles/iam.serviceAccountUser >/dev/null
# The load-test workflow reads Cloud Run instance count, CPU and memory from Cloud Monitoring (read-only).
gcloud services enable monitoring.googleapis.com --project "$PROJECT"
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$DEPLOY_SA" --role roles/monitoring.viewer \
  --condition=None >/dev/null

cat <<'EOF'

▸ Staging database. In Neon (console.neon.tech) open your project → Databases → New database, name it
  halqa_staging (an EMPTY database; do not create a branch of production, which would copy real data).
  Then Dashboard → Connection string → pick database halqa_staging → copy the string.
EOF
echo "Staging DATABASE_URL (hidden):"
read -rs DBURL; echo
[[ "$DBURL" == postgres* ]] || { echo "That does not look like a postgres:// connection string."; exit 1; }
PROD_DB="$(gcloud secrets versions access latest --secret "$PROD-database-url" --project "$PROJECT" 2>/dev/null | host_db || true)"
if [ -n "$PROD_DB" ] && [ "$(printf '%s' "$DBURL" | host_db)" = "$PROD_DB" ]; then
  echo "✋ That is the production database ($PROD_DB). Staging must use its own empty database."; exit 1
fi
printf '%s' "$DBURL" | put_secret "$SERVICE-database-url"
python3 -c 'import secrets;print(secrets.token_urlsafe(64),end="")' | put_secret "$SERVICE-secret-key"

STORAGE_ENV=""
read -rp "Connect a separate R2 bucket for staging recordings now? [y/N]: " R2
if [[ "$R2" == [yY]* ]]; then
  echo "  Create a bucket (e.g. halqa-staging) and an R2 API token limited to THAT bucket (Object Read & Write)."
  read -rp "Cloudflare account ID: " ACCOUNT; ACCOUNT="${ACCOUNT// /}"
  [[ "$ACCOUNT" =~ ^[0-9a-f]{32}$ ]] || { echo "That does not look like a Cloudflare account ID."; exit 1; }
  read -rp "Staging bucket name [halqa-staging]: " BUCKET; BUCKET="${BUCKET:-halqa-staging}"
  PROD_BUCKET="$(gcloud run services describe "$PROD" --project "$PROJECT" --region "$REGION" --format json 2>/dev/null \
    | python3 -c 'import json,sys;e=json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0].get("env",[]);print(next((x.get("value","") for x in e if x["name"]=="STORAGE_BUCKET"),""))' || true)"
  [ "$BUCKET" != "$PROD_BUCKET" ] || { echo "✋ $BUCKET is the production recordings bucket. Use a separate bucket."; exit 1; }
  read -rp "Access Key ID (staging token): " KEY_ID; KEY_ID="${KEY_ID// /}"
  echo "Secret Access Key (hidden):"; read -rs KEY_SECRET; echo
  [ -n "$KEY_ID" ] && [ -n "$KEY_SECRET" ] || { echo "Both keys are required."; exit 1; }
  printf '%s' "$KEY_SECRET" | put_secret "$SERVICE-storage-secret"; unset KEY_SECRET
  read -rp "EU jurisdiction bucket? [y/N]: " EU
  case "$EU" in [yY]*) ENDPOINT="https://$ACCOUNT.eu.r2.cloudflarestorage.com";; *) ENDPOINT="https://$ACCOUNT.r2.cloudflarestorage.com";; esac
  STORAGE_ENV="STORAGE_ENDPOINT_URL=$ENDPOINT,STORAGE_BUCKET=$BUCKET,STORAGE_ACCESS_KEY_ID=$KEY_ID,STORAGE_REGION=auto"
fi

cat <<EOF

✅ Staging secrets are in Secret Manager. Now in GitHub → ahmedmotaleb/Quran-app → Settings → Secrets and variables →
Actions:

  Secrets tab:    STAGING_DATABASE_URL = the same halqa_staging connection string (used for migrations and load tests)
  Variables tab:  STAGING_ENABLED      = 1
EOF
[ -z "$STORAGE_ENV" ] || echo "                  STAGING_STORAGE_ENV  = $STORAGE_ENV   (no secret in it; the key is in Secret Manager)"
cat <<EOF

From then on every merge deploys to staging first, migrates its database and checks it; production deploys only
after staging passes. Staging addresses:

  https://$SERVICE-$PNUM.$REGION.run.app/
  https://$SERVICE-admin-$PNUM.$REGION.run.app/admin/

Optional manual promotion: GitHub → Settings → Environments → production → Required reviewers (add yourself).
Production deploys then wait for your approval after staging is green.
EOF
