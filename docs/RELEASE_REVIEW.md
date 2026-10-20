# Release review (pack prompt 32)

**Date:** 20 October 2026 · **Commit:** `main` (after PR #48) · **Production:**
https://halqa-835293468002.europe-west1.run.app (Google Cloud Run, europe-west1; Neon PostgreSQL; Cloudflare R2)

One state per item: **PASS** (verified, with evidence), **PARTIAL** (works, with a named gap), **FAIL**,
**BLOCKED** (needs an owner decision or credential), **NOT TESTED**.

| Area | State | Evidence | Gap |
| --- | --- | --- | --- |
| Student web/PWA | PASS | E2E `live`, `loop`, `learn`, `reviews`, `schedule`, `quran`, `inbox` on every PR; production smoke: sign-up, onboarding, Mushaf, recording upload/playback | Real-device checks (see PWA row) |
| Teacher web/PWA | PASS | Students, assignments, review queue, feedback, schedule, attendance, grading and content authoring (drafts reviewed and published by admins) are live (E2E `loop`, `schedule`, `learn`, `teacher-content`). Mistakes tracking: points recorded at an ayah from a review, a session or the student file, follow-up tasks, resolve/reopen (E2E `mistakes`) | — |
| Parent web/PWA | PASS | E2E `parent`, `progress`: linked children only, no audio, same numbers as the student. «تسجيل دخول ولي الأمر» on the shared sign-in, `#/parent` link, setup link → parent sign-in, remembered child, mistakes summary without free text (E2E `parent-login`, `test_parent_portal.py`) | Installed-PWA parent session on a real phone (PWA QA) |
| Product Admin Portal | PASS | Sign-in with enforced two-step verification, people, circles, bookings, courses, quizzes, settings (support email halqa.app.eg@gmail.com), audit: all on the API (E2E `admin*`). Bulk actions with select-all, CSV export, bulk teacher assignment, enrollment and in-app messages, setup-email resend, saved views, archive/restore (E2E `admin-bulk`, `admin-ops`). Subscriptions are hidden (owner decision: no charge for now) | — |
| Backend/API + PostgreSQL | PASS | 242 tests on PostgreSQL in CI (concurrency, permissions, cross-role sweep); migrations check; `/api/ready` checks database, migrations, cache | — |
| Quran source/import integrity | PASS | Tanzil Uthmani v1.1, 6,236 ayahs; nightly restore drill re-verifies byte-for-byte; E2E `quran` shows the screen equals the served text; no generated text | — |
| Quran reader and audio practice | PASS | Bookmarks, reading position across devices, text size, ranges (E2E `reading`); repeat ×1–10 or continuous, speed, auto-advance (E2E `quran-audio`). Ayah audio from the licensed Quran Foundation Content API (Quran.com), production keys: Ops `audio-check` on 19 October fetched Al-Fatihah's 7 ayahs from `verses.quran.foundation` | Not yet listened to on a real phone (PWA QA) |
| Private media storage | PASS | R2 private bucket, presigned reads; smoke after every deploy: upload, owner playback, anonymous and unsigned refused; 200 KB upload 0.7–1.4 s. Recordings deleted 48 h after the teacher's review (hourly job; never before review) | Recordings not backed up, and deleted 48 h after review (owner decisions in RECOVERY.md) |
| Email / password recovery | PASS | Gmail SMTP in production (`/api/ready` → `email: smtp`); owner confirmed on 17 October 2026 that a real «نسيت كلمة المرور» email arrived and its link set a new password | — |
| Subscriptions/payments | NOT TESTED (not enabled) | Owner decision: no charge for now; the section is hidden in the live portal | — |
| Notifications | PARTIAL | In-app inbox and bell for all events (E2E `inbox`); hourly reminders job runs in production; Web Push built and tested (`test_push.py`, `e2e/push.mjs`), off until `deploy/gcp-push.sh` runs | Push not yet verified on a real phone; email reminders need SMTP |
| Live sessions | PASS | Meeting-link adapter: teacher adds the participant link (host links refused); `bookings/<id>/join` gives it only to the booked student inside the join window; early, late, cancelled, wrong-user and parent requests refused (`test_live_sessions.py`, E2E `live-session`) | Calls run in the meeting service, so the app has no evidence of who joined; the teacher marks attendance |
| CI/E2E | PASS | Backend, Web (typecheck, build, PWA cache rules, npm audit, CSP in the production image), E2E live mode (25 suites, 7 handbook journeys) gate every PR | — |
| Security | PASS | Admin MFA enforced in production; lockout; throttles; CSP/HSTS/frame/permissions headers; argon2id; IDOR sweep; pip-audit and npm audit clean | Alerts for abuse need `gcp-ops.sh` (below) |
| Performance/load | PARTIAL | Two runs on a Cloud Run-sized container: 50 active students + 10 staff/parents, 0 % errors, p95 21–23 ms, p99 265–310 ms, peaks 62 % CPU / 343 MiB, booking race 1 of 50 ([LOADTEST.md](LOADTEST.md)) | Not yet measured on Cloud Run + Neon itself or above 50 active users |
| Backups/restore | PASS | Nightly drill restores production into an isolated database and verifies sign-in, Quran and media rows. Encrypted copies kept 30 days: first kept run 17 October (run 39056054938: 789 KB dump 25 s, restore 1 s, verify 4 s, `stored=yes`, artifact `halqa-db-backup-39056054938`). RPO 24 h / RTO 1 h (owner) | Neon's own extension (`pg_session_jwt`) is skipped on restore with a warning; checks pass |
| Monitoring/alerts | PARTIAL | `deploy/gcp-ops.sh` ran: 9 alert policies emailing halqa.app.eg@gmail.com, uptime check, log metrics; alert drill passed on 17 October (run 39063257562, all 6 synthetic events found) ([MONITORING.md](MONITORING.md)) | Owner to confirm the drill's alert emails arrived (check spam) |
| Cloud Run deployment | PASS | Deploy on merge with migrations first; smoke test after each deploy; hourly maintenance job green | No separate staging service |
| Android APK | NOT TESTED (not required) | PWA is the client by decision | Prompt 30 only if an APK is required |

## Risks re-checked (prompt 32 list)

- **Admin screens in live mode use the API, not demo state:** yes. Subscriptions is hidden in the live portal (no charge for now).
- **Progress is consistent across roles:** one server calculation. `test_progress.py` and E2E `progress` compare the student, teacher and parent views.
- **Spaced repetition does not duplicate or inflate:** there is one review task per cycle, enforced by the database. Memorization counts distinct accepted ayahs (`test_reviews.py`, `test_progress.py`).
- **Recording storage and reset email are actually configured:** storage yes. Email configured (Gmail SMTP) and real delivery confirmed by the owner.
- **Live-session sample content is not presented as real:** the simulated call is gone from the live app; sessions open the teacher's meeting link.
- **Capacity claims are measured:** only the measured range is claimed (LOADTEST.md).

## Release blockers, by severity

1. **Real-device PWA QA not done** (medium): microphone and recording format on iPhone are the main unknowns.

Resolved 17 October: password-reset email (owner confirmed real delivery and a working link); kept encrypted
backups (`BACKUP_PASSPHRASE` set, first stored copy verified); alerts switched on (drill passed; email receipt to
be confirmed). Resolved 19 October: ayah audio from the licensed Quran Foundation source, production.

Payments, push and live video are product scope, not blockers for a recitation pilot.

## Changes since 19 October (PR #44)

- PWA install suggestion with Android/iPhone steps (#46).
- Prompt 33, student mistakes tracking (#47): `Correction` model, role-scoped API (parents get no free text, students no internal note), «أخطائي», progress, parent and teacher cards, admin aggregate.
- Prompt 34, parent sign-in entry (#47).
- Prompt 36, admin operations (#48): export, bulk assign, enroll, message, resend setup, saved views.
- E2E made independent of the time of day: bookings are made two days ahead, and the recovery throttle is raised for the shared CI address.
- Open: «نقل إلى حلقة» waits for a circle-membership decision.

## Changes since 16 October (`06bc3f4`)

Owner decisions applied: subscriptions hidden, support email, recordings deleted 48 h after review, ayah audio off
until licensed. Prompt 18 (Web Push, off until keys), 19 (live sessions via meeting links), 20 (bookmarks and
position), 21 (audio practice controls), teacher content drafts, lesson files.

## Changes since the previous review (`e9c4c25`, 15 October)

Prompts 04–08 (admin portal on the API), 11–17 (progress, reviews, Today plan, notifications, question
versioning), 22 (scheduled jobs), 23 (email code), 24 (security), 25 (load test with two fixes), 26
(monitoring), 27 (backup drill), 28 (E2E in CI, which caught a sign-out race), 29 (PWA update safety).

## Next actions

1. **Confirm alert emails.** Check halqa.app.eg@gmail.com (and spam) for "Halqa: operational failure" from the
   17 October drill; run **Ops → alert-drill** again if none arrived.
2. **Real-device pilot check.** Complete the table in [PWA_QA.md](PWA_QA.md) on one Android phone and one
   iPhone, with one real teacher and two students for a week.
   *Done when* every row is ✅ or has a filed defect, and an iPhone recording has been submitted and played by the teacher.
