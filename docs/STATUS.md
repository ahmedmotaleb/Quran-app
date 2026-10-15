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
| Student | Lessons, quizzes, progress | implemented | `test_lessons_quizzes.py`; `e2e/learn.mjs` locally | Production has no content yet (needs admin content tools) |
| Student | Mushaf (verified text) | live | 6,236 ayahs imported and byte-verified (Ops run); smoke step passes | — |
| Teacher | Students, assignments, review queue, scores, notes | implemented | `test_media_submissions.py`, `e2e/loop.mjs` | — |
| Teacher | Schedule, occurrences, attendance, grading | implemented | `test_teacher_schedule.py`, `test_lessons_quizzes.py` | — |
| Teacher | Content authoring (lectures, quizzes) | simulated | `src/screens/teacher` `tcontent` is in `SAMPLE_SCREENS` | Pack prompt 07 (admin content first) |
| Teacher | Voice notes on feedback | partial | Backend upload exists; hidden in live UI | Later |
| Parent | Linked children, sessions, tasks, progress, no audio | implemented | `test_permissions.py`, `e2e/parent.mjs` | — |
| Admin | Portal sign-in | implemented | Real `admin/auth/login`, OTP step, session restore; `e2e/admin.mjs` | — |
| Admin | Users, teachers, parents | implemented | Live sections on `admin/users*`, approval, links, setup links, teacher invitations; `test_admin_people.py`, `e2e/admin-people.mjs` | — |
| Auth | Set-password and invitation pages | implemented | `#/reset`, `#/invite` (`src/screens/auth/LinkPages.tsx`) | Email delivery (pack 23) |
| Admin | Circles, bookings | simulated | UI reads `initialCircles`/`initialBookings` | Pack prompt 06 |
| Admin | Courses, lessons, quizzes | simulated | UI reads `initialContent`; no admin content API on `main` (draft on branch `admin-console-wip`) | Pack prompt 07 |
| Admin | Settings, audit log | simulated (UI) | `AppSettings` model exists; no admin API on `main` | Pack prompt 08 |
| Backend | Auth, roles, CSRF, throttles, audit events | implemented | `test_auth.py`, `test_permissions.py` | Pack prompt 24 re-check |
| PWA | Installable, offline shell, update prompt | live | Smoke "PWA installable" passes on production | Pack prompt 29 device QA |
| Deployment | Cloud Run, deploy on merge, migrations before release | live | `deploy-cloudrun.yml` runs green; `/api/ready` ok | — |
| Storage | Private recordings (Cloudflare R2) | live | `/api/ready` → `media_storage: configured`; smoke upload, owner playback, anonymous refused | — |
| Email | Password-reset delivery | blocked | `/api/ready` → `email: log_only` | Choose an email provider (pack 23) |
| Domain | Custom domain | missing | App served at `halqa-835293468002.europe-west1.run.app` | Optional |
| Recovery | Backups, restore drill | missing | Only Neon's built-in history; no tested restore | Pack prompt 27 |
| Monitoring | Error tracking, alerts | missing | Cloud Run default logs only; 1 USD budget alert | Pack prompt 26 |
| Live video | Live sessions | missing | Needs a provider decision | Pack prompt 19 |
| Commercial | Subscriptions, payments | missing | Admin «الاشتراكات» is demo only | Pack prompts 09–10 |
| Android | Native APK | not present (by decision) | Capacitor project removed; PWA is the client | Pack prompt 30 only if required |

## Top gaps (user impact × release risk)

1. ~~Admin sign-in (04)~~ and ~~users/teachers/parents (05)~~ — done.
3. No way to create courses/lessons/quizzes in production (07) — learners see an empty library.
4. Admin bookings/circles simulated (06).
5. Settings not editable (08).
6. Password-reset email not delivered (23) — a user who forgets a password is stuck.
7. No tested backup/restore (27).
8. No error tracking or alerting (26).
9. Teacher content authoring still sample (07, teacher side).
10. Live video sessions undecided (19).

The rest of the live Admin Portal (06–08) remains the highest-priority gap. Next prompt: **06**.
