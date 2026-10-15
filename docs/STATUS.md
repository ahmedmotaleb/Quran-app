# Project status (evidence-based)

Audited 15 October 2026 at `main` = `e9c4c25` (PR #10). Status words: **implemented** (code + tests),
**live** (verified on production), **partial**, **simulated** (UI on in-memory demo data), **missing**,
**blocked** (needs an owner decision or credential). Production checks were made with the Ops
workflow's smoke test, which signs up a throwaway student, from GitHub's network.

## By area

| Area | Feature | Status | Evidence | Next action |
| --- | --- | --- | --- | --- |
| Student | Sign-up, sign-in, onboarding, session restore | live | `e2e/smoke.mjs` passes on production | — |
| Student | Tasks, recording upload, submission, feedback | live | `test_media_submissions.py`; smoke upload/playback step passes on R2 | — |
| Student | Teachers, slots, book/cancel/reschedule | implemented | `test_booking.py` (concurrency, idempotency); `e2e/schedule.mjs` locally | Verify on production with a real teacher |
| Student | Lessons, quizzes | implemented | `test_lessons_quizzes.py`; `e2e/learn.mjs` | Add content via the admin console |
| All roles | In-app notifications + inbox | implemented | Events: assignment, submission, feedback, booking confirm/cancel/reschedule (both sides), 24h session reminder records, absence (student + guardians), review due, course lesson/quiz publication (enrolled only); bell + inbox; `test_notifications.py`, `e2e/inbox.mjs` | Push/email delivery (pack 18) |
| Student/Teacher | Spaced-repetition reviews + Today plan | implemented | `apps/learning/reviews.py` (schedules, history, overrides; intervals in admin settings), `today` endpoint; `test_reviews.py`, `test_today.py`, `e2e/reviews.mjs` | — |
| Operations | Hourly maintenance (reminders, due reviews, orphan uploads) | implemented | `run_scheduled` command; Cloud Run job `halqa-tasks` updated on deploy; `scheduled.yml` hourly | Confirm first scheduled run is green |
| All roles | Progress analytics (one server calculation) | implemented | `apps/learning/progress.py`: `progress/me`, `teacher/students/<id>/progress`, `parent/children/<id>/progress`, `admin/progress`, `teacher/dashboard`, `parent/weekly-summary`; `test_progress.py`, `e2e/progress.mjs` | Weekly summary delivery (pack 18) |
| Student | Mushaf (verified text) | live | 6,236 ayahs imported and byte-verified (Ops run); smoke step passes | — |
| Teacher | Students, assignments, review queue, scores, notes | implemented | `test_media_submissions.py`, `e2e/loop.mjs` | — |
| Teacher | Schedule, occurrences, attendance, grading | implemented | `test_teacher_schedule.py`, `test_lessons_quizzes.py` | — |
| Teacher | Content authoring (lectures, quizzes) | simulated | `src/screens/teacher` `tcontent` is in `SAMPLE_SCREENS` | Pack prompt 07 (admin content first) |
| Teacher | Voice notes on feedback | partial | Backend upload exists; hidden in live UI | Later |
| Parent | Linked children, sessions, tasks, progress, no audio | implemented | `test_permissions.py`, `e2e/parent.mjs` | — |
| Admin | Portal sign-in | implemented | Real `admin/auth/login`, OTP step, session restore; `e2e/admin.mjs` | — |
| Admin | Users, teachers, parents | implemented | Live sections on `admin/users*`, approval, links, setup links, teacher invitations; `test_admin_people.py`, `e2e/admin-people.mjs` | — |
| Auth | Set-password and invitation pages | implemented | `#/reset`, `#/invite` (`src/screens/auth/LinkPages.tsx`) | Email delivery (pack 23) |
| Admin | Circles, bookings | implemented | `admin/circles*`, `admin/sessions/<id>/cancel`, `admin/bookings*`; `test_admin_scheduling.py`, `e2e/admin-scheduling.mjs` | — |
| Admin | Courses, lessons, enrollments, quizzes | implemented | `admin/courses*`, `admin/lessons*`, `admin/enrollments*`, `admin/tests*`, `admin/questions*` (versioned); `test_admin_content.py`, `e2e/admin-content.mjs` | Lesson file uploads (PDF/audio) from the console |
| Admin | Settings, audit log | implemented | `admin/settings` (password re-entry for sensitive keys), `admin/audit`, public `settings/public` read by the app; `test_admin_settings.py`, `e2e/admin-settings.mjs` | — |
| Admin | Subscriptions | simulated | Demo only; no payment provider | Pack prompts 09–10 (optional) |
| Backend | Auth, roles, CSRF, throttles, audit events | implemented | `test_auth.py`, `test_permissions.py` | — |
| Security | Prompt 24 hardening | implemented | Admin MFA required when deployed; per-account lockout; password-change throttle; shared (database) rate-limit cache; CSP + Permissions-Policy on every response; cross-role sweep over 24 id-bearing endpoints; `pip-audit` + `npm audit` in CI; `test_security.py`, `e2e/admin.mjs` with `MFA_ENFORCED=1` | Owner: turn on two-step verification at next admin sign-in |
| PWA | Installable, offline shell, update prompt | live | Smoke "PWA installable" passes on production | Pack prompt 29 device QA |
| Deployment | Cloud Run, deploy on merge, migrations before release | live | `deploy-cloudrun.yml` runs green; `/api/ready` ok | — |
| Storage | Private recordings (Cloudflare R2) | live | `/api/ready` → `media_storage: configured`; smoke upload, owner playback, anonymous refused | — |
| Email | Password-reset delivery | blocked | Code ready: SMTP settings, `deploy/gcp-email.sh`, send failures reported, no link ever logged (`test_auth.py`); `/api/ready` → `email: log_only` | Owner: choose an SMTP provider, verify a sender, run `deploy/gcp-email.sh` |
| Domain | Custom domain | missing | App served at `halqa-835293468002.europe-west1.run.app` | Optional |
| Recovery | Backups, restore drill | missing | Only Neon's built-in history; no tested restore | Pack prompt 27 |
| Monitoring | Error tracking, alerts | missing | Cloud Run default logs only; 1 USD budget alert | Pack prompt 26 |
| Live video | Live sessions | missing | Needs a provider decision | Pack prompt 19 |
| Commercial | Subscriptions, payments | missing | Admin «الاشتراكات» is demo only | Pack prompts 09–10 |
| Android | Native APK | not present (by decision) | Capacitor project removed; PWA is the client | Pack prompt 30 only if required |

## Top gaps (user impact × release risk)

1. ~~Admin sign-in (04)~~ and ~~users/teachers/parents (05)~~ — done.
3. ~~Courses/lessons/quizzes authoring (07)~~ — done in the admin console.
4. ~~Admin bookings/circles (06)~~ — done.
5. ~~Settings (08)~~ — done.
6. Password-reset email not delivered (23) — code is ready; needs the owner's SMTP provider and sender. Until then admins issue set-password links.
7. No tested backup/restore (27).
8. No error tracking or alerting (26).
9. Teacher content authoring still sample (07, teacher side).
10. Live video sessions undecided (19).

The admin portal is live except subscriptions (no payments yet). Prompts 22–24 are done (23 waits only for provider credentials). Next prompt: **25** (load test) → 26 → 27 → 28 → 29 → 32.
