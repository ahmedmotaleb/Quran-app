# Deploying الحلقة for free

One free web server runs both the PWA and the API at the same address. The database and recordings
storage are separate free services.

| Piece | Service | Free allowance (checked October 2026 — confirm on each site) |
| --- | --- | --- |
| App + API | **Render** — Hobby workspace, *Free* web service | 750 instance-hours/month, 512 MB RAM, 5 GB bandwidth/month. **Sleeps after 15 minutes without visitors; the first request then takes about a minute.** |
| PostgreSQL | **Neon** — Free plan | Permanent free plan (0.5–1 GB storage per project, 100 compute-hours/month, sleeps after 5 min idle). |
| Recordings | **Cloudflare R2** | 10 GB-month storage, 1 M writes and 10 M reads per month, free downloads. Cloudflare may ask for a payment card to enable R2. |
| Email (optional) | Any SMTP provider with a free plan | Needed for password-reset emails. Without it, reset links are only written to the server log. |

Why not Render's own free PostgreSQL? It is deleted 30 days after creation.

**What "free" costs you:** the sleep delay (a student opening the app in the morning waits up to a
minute for the first screen of data — the installed app itself opens instantly from cache), and the
bandwidth cap. When you have regular daily users, move the web service to a paid instance; nothing
in the code changes.

---

## 1. Database — Neon (about 5 minutes)

1. Sign up at neon.com → **New project** → name `halqa`, region **Frankfurt (eu-central-1)**, PostgreSQL 16 or later.
2. **Connection details** → turn **Connection pooling off** (use the *direct* connection) → copy the string.
   It looks like `postgresql://user:password@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`.
   Keep it secret.

## 2. App + API — Render (about 10 minutes)

1. Sign up at render.com with your GitHub account and allow access to the `Quran-app` repository.
2. **New → Blueprint** → choose the repository and the branch to deploy (`main` after the PR is merged).
   Render reads `render.yaml` and creates one free web service called `halqa`.
3. When asked for environment variables:
   - `DATABASE_URL` — the Neon string from step 1.
   - `DEFAULT_FROM_EMAIL` — e.g. `noreply@your-domain` (or leave empty for now).
   - Leave the `STORAGE_*` and `EMAIL_*` variables empty for now.
4. **Apply**. The first build takes a few minutes. When it is live, open
   `https://halqa-xxxx.onrender.com/api/ready` — it should show `"status":"ok"` and a `features`
   list telling you what is still not configured.

The server creates the database tables itself on every start (`migrate`).

## 3. Quran text and the first admin — GitHub Actions (about 5 minutes)

Render's free plan has no shell, so these one-off jobs run from GitHub against the Neon database.

1. GitHub → repository **Settings → Secrets and variables → Actions → New repository secret**:
   - `PROD_DATABASE_URL` — the same Neon string.
   - `ADMIN_PASSWORD` — a long password for the first admin (at least 10 characters, not common).
2. **Actions → "Ops (production database)" → Run workflow**:
   - `task: import-quran`, tick **accept_tanzil_terms** (the Tanzil license: the text is used
     verbatim, with attribution and a link to tanzil.net). The job downloads the Tanzil Uthmani
     text, refuses it unless every surah has the Hafs ayah count, stores it with its SHA-256, and
     verifies the stored copy byte-for-byte.
   - `task: create-admin`, `admin_email: you@example.com`.
3. Sign in at `https://halqa-xxxx.onrender.com/#/admin` and turn on two-step verification.

`/api/ready` should now show `"quran_text":"imported"`.

## 4. Recordings storage — Cloudflare R2 (when you are ready for uploads)

Until this is done, the app works but says «رفع التسجيلات غير مفعّل على الخادم بعد» when a student
submits a recording — it never pretends to upload.

1. Cloudflare dashboard → **R2** → **Create bucket** `halqa-recordings` (location: automatic or
   Eastern Europe). Leave **public access off** — recordings are private.
2. **R2 → Manage API tokens → Create token** with *Object Read & Write* on that bucket only.
   Copy the *Access Key ID*, *Secret Access Key* and the S3 endpoint
   (`https://<account-id>.r2.cloudflarestorage.com`).
3. Render → `halqa` → **Environment**: set `STORAGE_ENDPOINT_URL`, `STORAGE_BUCKET`,
   `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` → **Save** (it redeploys).
4. `/api/ready` should show `"media_storage":"configured"`.

## 5. Email (optional, for password resets)

Pick any provider with a free SMTP plan, verify your sender address or domain there, then set
`EMAIL_HOST`, `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD` (and `EMAIL_PORT` if not 587) on Render.
`/api/ready` then shows `"email":"smtp"`.

## 6. Check the deployment

From any machine with Node and Playwright:

```bash
node e2e/smoke.mjs ./shots https://halqa-xxxx.onrender.com/
```

It waits for the server to wake, checks Chrome reports the PWA installable, signs up a throwaway
student (`smoke+…@example.com`), and checks the Mushaf. Then install it on your phone:
Android Chrome → menu → *Install app*; iPhone Safari → Share → *Add to Home Screen*.

## Custom domain (optional)

Render → `halqa` → **Settings → Custom domains** (2 included free), add the DNS record it shows.
HTTPS certificates are automatic. Nothing in the app needs changing.

## What runs where

```
phone / browser ──HTTPS──▶ Render (Docker: gunicorn + Django)
                              ├─ /            the PWA (built into the image)
                              ├─ /api/...     the API
                              ├──▶ Neon PostgreSQL (all data)
                              └──▶ Cloudflare R2 (private recordings, short-lived signed links)
```
