#!/usr/bin/env bash
# One-time Google Cloud setup for الحلقة on Cloud Run. Run it in Cloud Shell (console.cloud.google.com → Shell):
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/ahmedmotaleb/Quran-app/main/deploy/gcp-setup.sh)
#
# It is safe to run again: existing resources are kept. It creates:
#   - the APIs it needs, an Artifact Registry repository (keeps only the 2 newest images, within the 0.5 GB free storage)
#   - a runtime service account (reads two secrets only) and a deploy service account
#   - keyless GitHub → Google Cloud login (Workload Identity Federation) limited to this repository
#   - Secret Manager secrets: DATABASE_URL (asked for, never echoed) and a generated Django secret key
#   - a 1 USD monthly budget alert (e-mails at 50% and 100%)
# and prints the three GitHub "variables" to add. No passwords or keys are stored in GitHub.
set -euo pipefail

REPO="${REPO:-ahmedmotaleb/Quran-app}"
REGION="${REGION:-europe-west1}"          # Belgium: Tier-1 price region, close to Neon Frankfurt
SERVICE="${SERVICE:-halqa}"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"

if [ -z "$PROJECT" ]; then
  echo "No project selected. Run:  gcloud config set project YOUR_PROJECT_ID   and start again."; exit 1
fi
PNUM="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
echo "Project: $PROJECT ($PNUM)   Region: $REGION   Repository: $REPO"

BILLING="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' 2>/dev/null || true)"
if [ -z "$BILLING" ]; then
  echo "Billing is not enabled on $PROJECT. Link a billing account (Billing → Link a billing account) and run again."; exit 1
fi

echo "▸ Enabling APIs (takes a minute the first time)…"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com cloudresourcemanager.googleapis.com billingbudgets.googleapis.com \
  --project "$PROJECT"

echo "▸ Artifact Registry repository…"
if ! gcloud artifacts repositories describe "$SERVICE" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$SERVICE" --repository-format=docker --location "$REGION" --project "$PROJECT" \
    --description "الحلقة app images"
fi
POLICY="$(mktemp)"
cat > "$POLICY" <<'JSON'
[
  {"name": "keep-newest-2", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 2}},
  {"name": "delete-older", "action": {"type": "Delete"}, "condition": {"olderThan": "1d"}}
]
JSON
gcloud artifacts repositories set-cleanup-policies "$SERVICE" --location "$REGION" --project "$PROJECT" \
  --policy "$POLICY" --no-dry-run >/dev/null
rm -f "$POLICY"

echo "▸ Service accounts…"
RUN_SA="$SERVICE-run@$PROJECT.iam.gserviceaccount.com"
DEPLOY_SA="$SERVICE-deploy@$PROJECT.iam.gserviceaccount.com"
gcloud iam service-accounts describe "$RUN_SA" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$SERVICE-run" --project "$PROJECT" --display-name "الحلقة runtime"
gcloud iam service-accounts describe "$DEPLOY_SA" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$SERVICE-deploy" --project "$PROJECT" --display-name "الحلقة deploy (GitHub Actions)"
for role in roles/run.admin roles/artifactregistry.writer; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$DEPLOY_SA" --role "$role" --condition=None >/dev/null
done
gcloud iam service-accounts add-iam-policy-binding "$RUN_SA" --project "$PROJECT" \
  --member "serviceAccount:$DEPLOY_SA" --role roles/iam.serviceAccountUser >/dev/null

echo "▸ Secrets…"
if ! gcloud secrets describe "$SERVICE-database-url" --project "$PROJECT" >/dev/null 2>&1; then
  echo "Paste the Neon connection string (direct, not pooled; starts with postgresql://). It will not be shown:"
  read -rs DBURL; echo
  case "$DBURL" in postgres://*|postgresql://*) ;; *) echo "That does not look like a postgresql:// URL. Run again."; exit 1;; esac
  case "$DBURL" in *-pooler.*) echo "This is the pooled string (-pooler). Turn pooling off in Neon's Connect box and run again."; exit 1;; esac
  printf '%s' "$DBURL" | gcloud secrets create "$SERVICE-database-url" --project "$PROJECT" --replication-policy automatic --data-file=-
  unset DBURL
else
  echo "  $SERVICE-database-url exists (to replace it: gcloud secrets versions add $SERVICE-database-url --data-file=-)"
fi
if ! gcloud secrets describe "$SERVICE-secret-key" --project "$PROJECT" >/dev/null 2>&1; then
  python3 -c 'import secrets;print(secrets.token_urlsafe(64),end="")' | \
    gcloud secrets create "$SERVICE-secret-key" --project "$PROJECT" --replication-policy automatic --data-file=-
fi
for s in "$SERVICE-database-url" "$SERVICE-secret-key"; do
  gcloud secrets add-iam-policy-binding "$s" --project "$PROJECT" --member "serviceAccount:$RUN_SA" \
    --role roles/secretmanager.secretAccessor >/dev/null
done

echo "▸ Keyless GitHub login (Workload Identity Federation)…"
POOL="github"
gcloud iam workload-identity-pools describe "$POOL" --location global --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools create "$POOL" --location global --project "$PROJECT" --display-name "GitHub Actions"
gcloud iam workload-identity-pools providers describe "$POOL" --workload-identity-pool "$POOL" --location global \
  --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools providers create-oidc "$POOL" --workload-identity-pool "$POOL" --location global \
    --project "$PROJECT" --display-name "GitHub" --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition "assertion.repository=='$REPO'"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --project "$PROJECT" --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$PNUM/locations/global/workloadIdentityPools/$POOL/attribute.repository/$REPO" >/dev/null

echo "▸ Budget alert (1 USD/month, e-mails at 50% and 100%)…"
BA="${BILLING#billingAccounts/}"
if ! gcloud billing budgets list --billing-account "$BA" --format='value(displayName)' 2>/dev/null | grep -qx "$SERVICE"; then
  gcloud billing budgets create --billing-account "$BA" --display-name "$SERVICE" --budget-amount 1USD \
    --filter-projects "projects/$PROJECT" --threshold-rule percent=0.5 --threshold-rule percent=1.0 >/dev/null \
    || echo "  (Could not create the budget automatically — create one in Billing → Budgets & alerts.)"
fi

cat <<EOF

✅ Done. Add these in GitHub → $REPO → Settings → Secrets and variables → Actions → **Variables** tab:

  GCP_PROJECT_ID     = $PROJECT
  GCP_WIF_PROVIDER   = projects/$PNUM/locations/global/workloadIdentityPools/$POOL/providers/$POOL
  GCP_DEPLOY_SA      = $DEPLOY_SA

and make sure the **Secrets** tab has PROD_DATABASE_URL (the same Neon string; used to apply database changes).
Then run Actions → "Deploy (Cloud Run)" → Run workflow. Your app will be at:

  https://$SERVICE-$PNUM.$REGION.run.app
EOF
