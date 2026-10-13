# Deploying الحلقة

One container runs both the PWA and the API at the same address on **Google Cloud Run**. The database
and recordings storage are separate free services. Every merge to `main` deploys automatically.

| Piece | Service | Free allowance (checked October 2026 — confirm on each site) |
| --- | --- | --- |
| App + API | **Google Cloud Run** (europe-west1) | Monthly: 2 million requests, 180,000 vCPU-seconds, 360,000 GiB-seconds, 1 GB outbound traffic in North America (other regions charged per GB). Scales to zero; **the first visit after a quiet spell takes a few seconds** while it starts. Needs a billing account (card). |
| Images | **Artifact Registry** | 0.5 GB storage free; the setup keeps only the 2 newest images. |
| PostgreSQL | **Neon** — Free plan | 0.5 GB storage per project, 100 compute-hours/month, sleeps after 5 min idle. |
| Recordings | **Cloudflare R2** | 10 GB-month storage, 1 M writes and 10 M reads per month, free downloads. |
| Email (optional) | Any SMTP provider with a free plan | Needed for password-reset emails. Without it, reset links are only written to the server log. |

**Cost guard:** the setup creates a 1 USD monthly budget that e-mails you at 50% and 100%. A budget
only warns, it does not stop spending; Cloud Run is capped at 2 instances so a traffic spike cannot run
away. Expect 0 USD at small scale; outbound traffic outside North America is the first thing billed.

---

## 1. Database — Neon

Already done if you have the Frankfurt project. Otherwise: neon.com → **New project** → region
**Frankfurt (eu-central-1)** → **Connect** → turn **Connection pooling off** → copy the string
(`postgresql://user:password@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`). Keep it secret.

## 2. Google Cloud — one script (about 10 minutes)

1. console.cloud.google.com → project picker → **New project** named `halqa` (a separate project keeps
   its bill and permissions apart from anything else you have). Select it.
2. **Billing** → link your billing account to the project.
3. Open **Cloud Shell** (the `>_` button, top right) and run:
   ```bash
   gcloud config set project YOUR_PROJECT_ID
   bash <(curl -fsSL https://raw.githubusercontent.com/ahmedmotaleb/Quran-app/main/deploy/gcp-setup.sh)
   ```
   It asks for the Neon string (typing is hidden), then prints three values.
   Read the script first if you like: `deploy/gcp-setup.sh`. Running it again is safe.

## 3. GitHub — connect the deploy

GitHub → repository **Settings → Secrets and variables → Actions**:

- **Variables** tab: add `GCP_PROJECT_ID`, `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA` exactly as printed.
- **Secrets** tab: `PROD_DATABASE_URL` — the same Neon string (used to apply database changes before each
  release).

Then **Actions → "Deploy (Cloud Run)" → Run workflow**. It builds the image, applies migrations, deploys,
and checks `https://halqa-<project-number>.europe-west1.run.app/api/ready`. GitHub never holds a Google
key: it signs in with a short-lived token that only this repository can obtain.

## 4. Quran text and the first admin — GitHub Actions (about 5 minutes)

Cloud Run has no shell, so these one-off jobs run from GitHub against the Neon database.

1. GitHub → repository **Settings → Secrets and variables → Actions → New repository secret**:
   - `PROD_DATABASE_URL` — already added in step 3.
   - `ADMIN_PASSWORD` — a long password for the first admin (at least 10 characters, not common).
2. **Actions → "Ops (production database)" → Run workflow**:
   - `task: import-quran`, tick **accept_tanzil_terms** (the Tanzil license: the text is used
     verbatim, with attribution and a link to tanzil.net). The job downloads the Tanzil Uthmani
     text, refuses it unless every surah has the Hafs ayah count, stores it with its SHA-256, and
     verifies the stored copy byte-for-byte.
   - `task: create-admin`, `admin_email: you@example.com`.
3. Sign in at `https://halqa-<number>.europe-west1.run.app/#/admin` and turn on two-step verification.

`/api/ready` should now show `"quran_text":"imported"`.

## 5. Recordings storage — Cloudflare R2 (when you are ready for uploads)

Until this is done, the app works but says «رفع التسجيلات غير مفعّل على الخادم بعد» when a student
submits a recording — it never pretends to upload.

1. Cloudflare dashboard → **R2** → **Create bucket** `halqa-recordings` (location: automatic or
   Eastern Europe). Leave **public access off** — recordings are private.
2. **R2 → Manage API tokens → Create token** with *Object Read & Write* on that bucket only.
   Copy the *Access Key ID*, *Secret Access Key* and the S3 endpoint
   (`https://<account-id>.r2.cloudflarestorage.com`).
3. Cloud Shell (secret values go to Secret Manager, not into the service settings):
   ```bash
   printf '%s' 'SECRET-ACCESS-KEY' | gcloud secrets create halqa-storage-secret --data-file=-
   gcloud secrets add-iam-policy-binding halqa-storage-secret --role roles/secretmanager.secretAccessor \
     --member serviceAccount:halqa-run@$(gcloud config get-value project).iam.gserviceaccount.com
   gcloud run services update halqa --region europe-west1 \
     --update-env-vars STORAGE_ENDPOINT_URL=https://<account-id>.r2.cloudflarestorage.com,STORAGE_BUCKET=halqa-recordings,STORAGE_ACCESS_KEY_ID=<key-id> \
     --update-secrets STORAGE_SECRET_ACCESS_KEY=halqa-storage-secret:latest
   ```
   Later deploys keep these settings.
4. `/api/ready` should show `"media_storage":"configured"`.

## 6. Email (optional, for password resets)

Pick any provider with a free SMTP plan, verify your sender address or domain there, then set
`EMAIL_HOST`, `EMAIL_HOST_USER` (and `EMAIL_PORT` if not 587) with `gcloud run services update halqa
--region europe-west1 --update-env-vars ...`, and the password as a secret `EMAIL_HOST_PASSWORD` the same way
as the storage key above.
`/api/ready` then shows `"email":"smtp"`.

## 7. Check the deployment

From any machine with Node and Playwright:

```bash
node e2e/smoke.mjs ./shots https://halqa-<number>.europe-west1.run.app/
```

Or run it from GitHub: **Actions → Ops → smoke-test** with the app address. It waits for the server to wake, checks Chrome reports the PWA installable, signs up a throwaway
student (`smoke+…@example.com`), and checks the Mushaf. Then install it on your phone:
Android Chrome → menu → *Install app*; iPhone Safari → Share → *Add to Home Screen*.

## Custom domain (optional)

Cloud Run → `halqa` → **Integrations / Custom domains** (or put Cloudflare in front). Then add the
new address to `DJANGO_ALLOWED_HOSTS` and `CSRF_TRUSTED_ORIGINS`, and set `APP_URL` to it.

## What runs where

```
phone / browser ──HTTPS──▶ Cloud Run (Docker: gunicorn + Django)
                              ├─ /            the PWA (built into the image)
                              ├─ /api/...     the API
                              ├──▶ Neon PostgreSQL (all data)
                              └──▶ Cloudflare R2 (private recordings, short-lived signed links)
```
