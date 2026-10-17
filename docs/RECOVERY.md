# Backup, restore and disaster recovery

## What is protected, and how

| Data | Mechanism | Frequency / retention | Encryption | Who can restore |
| --- | --- | --- | --- | --- |
| PostgreSQL (all accounts, links, tasks, submissions, feedback, bookings, content, Quran text, audit log) | 1. Neon point-in-time restore (provider) | Continuous, within the plan's history window (Neon Console → project → *Restore*; short on the free plan) | Neon at rest | Neon project owner |
|  | 2. Nightly `pg_dump` (workflow **Backup and restore drill**) | Every night 02:41 UTC; encrypted copy kept 30 days once `BACKUP_PASSPHRASE` is set | AES-256 (gpg, passphrase in GitHub secret `BACKUP_PASSPHRASE`) | Repository admins (secret + Actions) |
| Recordings (Cloudflare R2 bucket `halqa-recordings`) | Not copied (decision below); deleted 48 h after the teacher's review | — | R2 at rest | Cloudflare account owner |
| Quran text | In the database (above) + the public Tanzil source; the drill checks it byte-for-byte | — | — | — |
| Configuration | Code and deploy scripts in git; secrets in Google Secret Manager (versioned) and GitHub secrets | Every change | Google/GitHub | Project owner |

The nightly workflow is also the restore drill. It restores the fresh dump into a throwaway PostgreSQL on the
GitHub runner (never production) and runs `manage.py verify_restore` and `import_quran --verify` there. A failure
fails the workflow, and GitHub emails the owner.

The checks:
- migrations;
- admin, teacher and student sign-in through the real API (an admin with two-step verification must be asked
  for the code);
- a parent sees a linked child;
- the assigned teacher sees the student;
- a student sees feedback;
- 114 surahs and 6,236 ayahs, byte-for-byte equal to the source;
- every submission still has its recording metadata row;
- row counts.

## Decisions (owner, 16 October 2026)

- **RPO:** up to **24 hours** of data may be lost in a disaster, the nightly dump. Inside Neon's history window,
  minutes.
- **RTO:** the app is back within **1 hour**.
- **Support email:** halqa.app.eg@gmail.com (shown in the Help sheet; admins can change it in Settings).
- **Recordings are deleted 48 hours after the teacher reviews them** (task feedback or quiz grading), by the hourly
  `purge_reviewed_recordings` step. A recording still waiting for its teacher is never deleted. Scores, feedback text
  and timed notes stay; the student sees "deleted after 48 hours" instead of a player. Change with the
  `RECORDING_RETENTION_HOURS` setting.
- **Recordings are not backed up** for the pilot. Losing the R2 bucket would lose audio, but scores, feedback text
  and progress stay in the database. Revisit before recordings exceed R2's free 10 GB or before a paid launch.
- **Kept copies:** `BACKUP_PASSPHRASE` is set (17 October 2026); every nightly run keeps an encrypted copy for 30
  days. The passphrase must also be in the owner's password manager: without it the copies cannot be opened.

## Restore runbook

Never restore over production. Restore into a new database, verify it, then switch.

**A. Recent mistake, inside Neon's history window (fastest).** Neon Console → project → *Restore* (or *Branches →
Create branch* from a past time) → copy the new branch's connection string. Then continue with step D.

**B. From a nightly encrypted dump.** GitHub → Actions → *Backup and restore drill* → pick a run → download
`halqa-db-backup-…`. Then:

```bash
gpg --decrypt halqa-YYYYMMDD-HHMM.dump.gpg > halqa.dump          # asks for BACKUP_PASSPHRASE
createdb "<new database URL>"                                      # or create it in the Neon console
pg_restore --no-owner --no-acl -d "<new database URL>" halqa.dump
```

**C. Verify before switching** (from a checkout of this repository):

```bash
cd backend
APP_ENV=staging DATABASE_URL="<new database URL>" DJANGO_ALLOWED_HOSTS=testserver SECURE_SSL_REDIRECT=false \
  MEDIA_STORAGE=none DJANGO_SECRET_KEY=$(python -c 'import secrets;print(secrets.token_urlsafe(64))') \
  sh -c 'python manage.py createcachetable && python manage.py verify_restore'
```

`verify_restore` resets the passwords of the first admin, teacher and student **in that copy**. Afterwards, those
three must use "forgot password", or an admin sends them set-password links.

**D. Switch production to the restored database (about 5 minutes).**

```bash
printf '%s' "<new database URL>" | gcloud secrets versions add halqa-database-url --data-file=-
gcloud run services update halqa --region europe-west1 --update-secrets DATABASE_URL=halqa-database-url:latest
```

Also update the GitHub secret `PROD_DATABASE_URL`, used by deploy migrations, Ops and this drill. Then run
**Ops → smoke-test** and check `/api/ready`.

**Roll back the switch.** Add the previous connection string as a new secret version and run the same `gcloud run
services update`. Secret Manager keeps every version.

## Rebuilding everything else

| Lost | Rebuild |
| --- | --- |
| Cloud Run service or job | Push to `main` (the deploy workflow recreates both) |
| Google project setup | `deploy/gcp-setup.sh`, `deploy/gcp-r2.sh`, `deploy/gcp-email.sh`, `deploy/gcp-ops.sh` |
| R2 credentials | New R2 API token → `deploy/gcp-r2.sh` |
| Quran text | Ops → `import-quran` (Tanzil), then `verify-quran` |
