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
3. Sign in at `https://halqa-<number>.europe-west1.run.app/admin/` and turn on two-step verification.

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

Pick any provider with a free SMTP plan and verify your sender address or domain there. Then, in Cloud Shell:

```bash
bash deploy/gcp-email.sh
```

It asks for the SMTP host, port, user, sender address and password; the password is stored in Secret Manager
(`halqa-email-password`), never in the service settings. `/api/ready` then shows `"email":"smtp"`.
Until then the app sends no email at all (it records `email_not_sent_no_provider` in the log, without the
link) and admins hand out set-password links from the console instead.

## 6a. Phone notifications (optional, free)

Web Push needs no outside account. In Cloud Shell:

```bash
bash deploy/gcp-push.sh
```

It generates the app's signing keys, puts the private key in Secret Manager (`halqa-vapid-private`), and sets
`VAPID_PUBLIC_KEY` on the service and the maintenance job. `/api/ready` then shows `"push":"configured"`. Each
person turns it on per device in «حسابي» → «إشعارات على هذا الجهاز». Lock-screen text is generic; details stay
in the app. On iPhone and iPad the app must be installed to the home screen (iOS 16.4 or later).

## 6b. Hourly maintenance job

Every deploy also updates a Cloud Run **job** `halqa-tasks` (same image and settings as the service) that runs
`python manage.py run_scheduled`: session reminders, due review tasks, and removal of abandoned uploads. The
GitHub workflow **Scheduled maintenance** starts it at minute 23 of every hour; a failed step fails the run, so
GitHub emails the repository owner. Run it by hand from **Actions → Scheduled maintenance → Run workflow**.

## 6c. Security settings

| Setting | Default when deployed | Purpose |
| --- | --- | --- |
| `ADMIN_REQUIRE_MFA` | `true` | Admin APIs refuse an admin who has not turned on two-step verification; the portal shows only the setup card until then. |
| `LOGIN_LOCKOUT_FAILURES` / `LOGIN_LOCKOUT_MINUTES` | `10` / `15` | Wrong passwords (or wrong admin codes) for one account, from any address, lock that account's sign-in for 15 minutes. |
| `THROTTLE_AUTH` / `THROTTLE_RECOVERY` | `10/min` / `5/hour` | Per-address limits on sign-in, password change, MFA codes and recovery. |

Rate limits and lockouts are stored in a database table (`halqa_cache`, created by `createcachetable` during
deploy) so every instance shares them. Every response carries a Content-Security-Policy that allows only this
site, Google Fonts, signed recording links on Cloudflare R2, and the ayah-audio host only when one is approved.

**Ayah audio (licensed source: Quran Foundation / Quran.com).** The Mushaf plays reference recitation only from a
licensed source. The approved one is the Quran Foundation Content API: create a *Backend/server app* in the
[Developer Console](https://dev-console.quran.foundation/projects), then run in Cloud Shell:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/ahmedmotaleb/Quran-app/main/deploy/gcp-quran-audio.sh)
```

It checks the keys with Quran Foundation, stores the client secret in Secret Manager (`halqa-qf-client-secret`) and sets
`QF_CLIENT_ID` and `QF_ENV` on the service. `/api/ready` then shows `"ayah_audio":"quran_foundation_prelive"`.
Pre-live keys serve **Al-Fatihah and Al-Baqarah only**; after Quran Foundation approves production access, run the
script again with the production keys and answer `production`. Optional: `QF_RECITATION_ID` (default 7, Mishari
al-Afasy) and `QF_RECITER_NAME`. The server caches each surah's URL list for one day (the terms allow at most a
week); browsers stream the files from Quran Foundation's CDN, the only audio host the CSP allows. The Mushaf credits
«Quran.com». To switch audio off, remove `QF_CLIENT_ID` and `QF_CLIENT_SECRET` from the service.

## 6d. Staging (dev → staging → production)

Staging is a second copy of the app for realistic checks before production. It shares nothing that holds data or
secrets with production:

| | Staging | Production |
| --- | --- | --- |
| Cloud Run | `halqa-staging`, `halqa-staging-admin` (0–2 instances) | `halqa`, `halqa-admin` |
| Runtime account | `halqa-staging-run` (reads only `halqa-staging-*` secrets) | `halqa-run` |
| Database | its own **empty** Neon database `halqa_staging` | Neon production database |
| Recordings | optional own R2 bucket + own key (none = uploads off) | `halqa-recordings` |
| Email / push | none (links are shown on screen) | as configured |
| `APP_ENV` | `staging` | `production` |

Setup, once: run `bash <(curl -fsSL https://raw.githubusercontent.com/ahmedmotaleb/Quran-app/main/deploy/gcp-staging.sh)`
in Cloud Shell. It refuses the production database or bucket. Then add the GitHub secret `STAGING_DATABASE_URL` and
the variable `STAGING_ENABLED=1` (plus `STAGING_STORAGE_ENV` if you connected a bucket), as it prints.

From then on **Deploy (Cloud Run)** runs: build → staging migrations → staging deploy → staging checks (ready,
admin portal, smoke test) → production. If staging fails, production is not touched. For a manual promotion step,
add yourself as a required reviewer on the GitHub environment **production**. Without `STAGING_ENABLED` the
workflow deploys production directly, as before.

Staging data is synthetic only (`seed_load`, smoke-test accounts, what testers create). Never copy production data,
recordings or a production database branch into staging.

## 6e. Google Calendar + Google Meet for sessions (optional)

Teachers connect their own Google Calendar once; every session they create in HALQA (المواعيد → «إنشاء جلسة») then
gets a Calendar event on their calendar with a **Google Meet created by Google**, the student (or the circle's active
members) invited by Google, and the Meet link stored privately in HALQA. Students join from HALQA inside the join
window; they never need to connect Google. HALQA keeps scheduling, attendance and evaluation; nothing academic is
written to Google (title, type and time only).

1. **Google Cloud console → APIs & Services → Library → Google Calendar API → Enable** (the script below also does it).
2. **OAuth consent screen** (Google Auth Platform → Branding / Audience / Data access):
   - App name «الحلقة», support email, developer contact.
   - Audience: **External** (or **Internal** if every teacher has an account in the academy's Google Workspace — no
     verification, no 7-day limit).
   - Data access → add scopes `openid`, `.../auth/userinfo.email` and `.../auth/calendar.events` only.
   - While in **Testing**: add each teacher's Google email under *Test users*. Google ends Testing authorizations
     after **7 days**, so teachers reconnect weekly until the app is published.
3. **Clients → Create client → Web application**, Authorized redirect URI exactly:
   `https://halqa-<project-number>.europe-west1.run.app/api/v1/integrations/google/callback`
   (the script prints the exact value). Copy the Client ID and secret — never put them in Git.
4. Cloud Shell: `bash <(curl -fsSL https://raw.githubusercontent.com/ahmedmotaleb/Quran-app/main/deploy/gcp-google-calendar.sh)`
   — stores the secret and a generated token-encryption key in Secret Manager and updates the app, the admin portal
   and the hourly job (`GOOGLE_CLIENT_ID`, `GOOGLE_REDIRECT_URI`, secrets `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_KEY`).

**Publishing beyond Testing:** `calendar.events` is a *sensitive* scope. Publishing an External app «In production»
needs Google's verification: a home page and privacy policy on a domain you own and have verified (the default
`run.app` address cannot be verified), a short video of the flow, and a justification. Until then use Testing (with
the weekly reconnect) or Internal (Google Workspace).

**Security:** refresh tokens are encrypted (Fernet) with `GOOGLE_TOKEN_KEY`; access tokens are never stored; no
token, authorization code or Meet link is written to logs or the audit trail; the OAuth `state` is signed,
single-use, 10 minutes, and accepted only for the teacher who started it.

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
