# Release review (pack prompt 32)

**Date:** 17 October 2026 · **Commit:** `main` at `6035033` · **Production:**
https://halqa-835293468002.europe-west1.run.app (Google Cloud Run, europe-west1; Neon PostgreSQL; Cloudflare R2)

One state per item: **PASS** (verified, with evidence), **PARTIAL** (works, with a named gap), **FAIL**,
**BLOCKED** (needs an owner decision or credential), **NOT TESTED**.

| Area | State | Evidence | Gap |
| --- | --- | --- | --- |
| Student web/PWA | PASS | E2E `live`, `loop`, `learn`, `reviews`, `schedule`, `quran`, `inbox` on every PR; production smoke: sign-up, onboarding, Mushaf, recording upload/playback | Real-device checks (see PWA row) |
| Teacher web/PWA | PASS | Students, assignments, review queue, feedback, schedule, attendance, grading and content authoring (drafts reviewed and published by admins) are live (E2E `loop`, `schedule`, `learn`, `teacher-content`) | — |
| Parent web/PWA | PASS | E2E `parent`, `progress`: linked children only, no audio, same numbers as the student | — |
| Product Admin Portal | PASS | Sign-in with enforced two-step verification, people, circles, bookings, courses, quizzes, settings (support email halqa.app.eg@gmail.com), audit: all on the API (E2E `admin*`). Subscriptions are hidden (owner decision: no charge for now) | — |
| Backend/API + PostgreSQL | PASS | 198 tests on PostgreSQL in CI (concurrency, permissions, cross-role sweep); migrations check; `/api/ready` checks database, migrations, cache | — |
| Quran source/import integrity | PASS | Tanzil Uthmani v1.1, 6,236 ayahs; nightly restore drill re-verifies byte-for-byte; E2E `quran` shows the screen equals the served text; no generated text | — |
| Quran reader and audio practice | PARTIAL | Bookmarks, reading position across devices, text size, ranges (E2E `reading`); repeat ×1–10 or continuous, speed, auto-advance (E2E `quran-audio` with a test source) | Ayah audio off in production until a licensed source is approved (owner decision) |
| Private media storage | PASS | R2 private bucket, presigned reads; smoke after every deploy: upload, owner playback, anonymous and unsigned refused; 200 KB upload 0.7–1.4 s. Recordings deleted 48 h after the teacher's review (hourly job; never before review) | Recordings not backed up, and deleted 48 h after review (owner decisions in RECOVERY.md) |
| Email / password recovery | PARTIAL | Gmail SMTP configured in production (`/api/ready` → `email: smtp`) | A real reset email and link still to be confirmed by the owner |
| Subscriptions/payments | NOT TESTED (not enabled) | Owner decision: no charge for now; the section is hidden in the live portal | — |
| Notifications | PARTIAL | In-app inbox and bell for all events (E2E `inbox`); hourly reminders job runs in production; Web Push built and tested (`test_push.py`, `e2e/push.mjs`), off until `deploy/gcp-push.sh` runs | Push not yet verified on a real phone; email reminders need SMTP |
| Live sessions | PASS | Meeting-link adapter: teacher adds the participant link (host links refused); `bookings/<id>/join` gives it only to the booked student inside the join window; early, late, cancelled, wrong-user and parent requests refused (`test_live_sessions.py`, E2E `live-session`) | Calls run in the meeting service, so the app has no evidence of who joined; the teacher marks attendance |
| CI/E2E | PASS | Backend, Web (typecheck, build, PWA cache rules, npm audit, CSP in the production image), E2E live mode (21 suites, 7 handbook journeys) gate every PR | — |
| Security | PASS | Admin MFA enforced in production; lockout; throttles; CSP/HSTS/frame/permissions headers; argon2id; IDOR sweep; pip-audit and npm audit clean | Alerts for abuse need `gcp-ops.sh` (below) |
| Performance/load | PARTIAL | Two runs on a Cloud Run-sized container: 50 active students + 10 staff/parents, 0 % errors, p95 21–23 ms, p99 265–310 ms, peaks 62 % CPU / 343 MiB, booking race 1 of 50 ([LOADTEST.md](LOADTEST.md)) | Not yet measured on Cloud Run + Neon itself or above 50 active users |
| Backups/restore | PARTIAL | Nightly drill restores production into an isolated database and verifies sign-in, Quran and media rows (first run: 17 s dump, <1 s restore, 3 s verify) | Encrypted copies are kept only after the owner sets `BACKUP_PASSPHRASE`; RPO/RTO await owner decision |
| Monitoring/alerts | BLOCKED | Signals, nine alert policies, uptime check and alert drill are ready ([MONITORING.md](MONITORING.md)) | Owner runs `deploy/gcp-ops.sh` once (needs project-owner rights), then the `alert-drill` |
| Cloud Run deployment | PASS | Deploy on merge with migrations first; smoke test after each deploy; hourly maintenance job green | No separate staging service |
| Android APK | NOT TESTED (not required) | PWA is the client by decision | Prompt 30 only if an APK is required |

## Risks re-checked (prompt 32 list)

- **Admin screens in live mode use the API, not demo state:** yes. Subscriptions is hidden in the live portal (no charge for now).
- **Progress is consistent across roles:** one server calculation. `test_progress.py` and E2E `progress` compare the student, teacher and parent views.
- **Spaced repetition does not duplicate or inflate:** there is one review task per cycle, enforced by the database. Memorization counts distinct accepted ayahs (`test_reviews.py`, `test_progress.py`).
- **Recording storage and reset email are actually configured:** storage yes. Email configured (Gmail SMTP); delivery to be confirmed.
- **Live-session sample content is not presented as real:** the simulated call is gone from the live app; sessions open the teacher's meeting link.
- **Capacity claims are measured:** only the measured range is claimed (LOADTEST.md).

## Release blockers, by severity

1. **Password recovery email not yet confirmed** (high). SMTP is configured; a real reset email and link must be checked once.
2. **Alerts are not switched on** (high for a pilot). Failures would go unnoticed until users report them.
3. **No kept backup copies** (medium). The drill proves restores work, but only Neon's short history holds past data until `BACKUP_PASSPHRASE` is set.
4. **Real-device PWA QA not done** (medium): microphone and recording format on iPhone are the main unknowns.

Payments, push and live video are product scope, not blockers for a recitation pilot.

## Changes since 16 October (`06bc3f4`)

Owner decisions applied: subscriptions hidden, support email, recordings deleted 48 h after review, ayah audio off
until licensed. Prompt 18 (Web Push, off until keys), 19 (live sessions via meeting links), 20 (bookmarks and
position), 21 (audio practice controls), teacher content drafts, lesson files.

## Changes since the previous review (`e9c4c25`, 15 October)

Prompts 04–08 (admin portal on the API), 11–17 (progress, reviews, Today plan, notifications, question
versioning), 22 (scheduled jobs), 23 (email code), 24 (security), 25 (load test with two fixes), 26
(monitoring), 27 (backup drill), 28 (E2E in CI, which caught a sign-out race), 29 (PWA update safety).

## Next three actions

1. **Confirm password-reset email.** SMTP is on (`/api/ready` → `"email":"smtp"`). Use "forgot password" on a
   real account. *Done when* the email arrives and its link sets a new password.
2. **Switch on alerts and kept backups.** Run `bash deploy/gcp-ops.sh` in Cloud Shell, then **Ops → alert-drill**.
   Add the `BACKUP_PASSPHRASE` repository secret and run **Backup and restore drill**.
   *Done when* the drill emails "Halqa: operational failure" to the owner, and the backup run shows `stored=yes`
   with a `halqa-db-backup-…` artifact.
3. **Real-device pilot check.** Complete the table in [PWA_QA.md](PWA_QA.md) on one Android phone and one
   iPhone, with one real teacher and two students for a week.
   *Done when* every row is ✅ or has a filed defect, and an iPhone recording has been submitted and played by the teacher.
