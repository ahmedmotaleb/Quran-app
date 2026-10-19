# Project status (evidence-based)

Audited 15 October 2026 at `main` = `e9c4c25` (PR #10); rows updated through 17 October 2026 (PR #36). Status words: **implemented** (code + tests),
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
| All roles | In-app notifications + inbox | implemented | Events: assignment, submission, feedback, booking confirm/cancel/reschedule (both sides), 24h session reminder records, absence (student + guardians), review due, course lesson/quiz publication (enrolled only); bell + inbox; `test_notifications.py`, `e2e/inbox.mjs` | Email reminders need SMTP (pack 23) |
| All roles | Web Push to phones (prompt 18) | implemented, off | Per-device opt-in on «حسابي» (asked only on tap, explained in Arabic, iOS needs the installed app); every in-app notification is also pushed with generic lock-screen text (no names, scores or ranges); gone endpoints removed; `/api/ready` → `push`; `test_push.py`, `e2e/push.mjs` (handler checked by an injected push) | Owner: run `deploy/gcp-push.sh` (no account needed), then test on a real phone |
| Student/Teacher | Spaced-repetition reviews + Today plan | implemented | `apps/learning/reviews.py` (schedules, history, overrides; intervals in admin settings), `today` endpoint; `test_reviews.py`, `test_today.py`, `e2e/reviews.mjs` | — |
| Operations | Hourly maintenance (reminders, due reviews, orphan uploads) | live | Cloud Run job `halqa-tasks` (updated on deploy) ran green in production; hourly trigger from GitHub until `gcp-ops.sh` moves it to Cloud Scheduler | — |
| All roles | Progress analytics (one server calculation) | implemented | `apps/learning/progress.py`: `progress/me`, `teacher/students/<id>/progress`, `parent/children/<id>/progress`, `admin/progress`, `teacher/dashboard`, `parent/weekly-summary`; `test_progress.py`, `e2e/progress.mjs` | Weekly summary delivery (pack 18) |
| Student | Mushaf (verified text) | live | 6,236 ayahs imported and byte-verified (Ops run); smoke step passes | — |
| Student | Reading position and bookmarks (prompt 20) | implemented | `quran/position`, `quran/bookmarks` (references only, separate from the canonical text, private labels); the Mushaf reopens where the reader stopped on any device; bookmark list jumps across surahs; live mode names the verified source; `test_reading.py`, `e2e/reading.mjs` (CI, with the imported text) | Ayah audio source licensing (prompt 21) — owner to confirm everyayah.com terms or choose a licensed source |
| Student | Ayah audio practice (prompt 21) | live (Quran Foundation, production) | Range play, repeat ×1/3/5/10 or continuous, speed 0.75–1.25×, carry on past the range, current ayah followed, stops on leaving. Audio URLs per surah from the Quran Foundation Content API (`apps/quran/qf_audio.py`, `quran/audio/<n>`, OAuth2 client credentials, secret in Secret Manager); files streamed from QF's CDN; Ops `audio-check` verified production on 19 October (`test_quran_audio.py`, `e2e/quran-audio.mjs`). everyayah.com gave no permission and is not used | — |
| Teacher | Students, assignments, review queue, scores, notes | implemented | `test_media_submissions.py`, `e2e/loop.mjs` | — |
| Teacher | Schedule, occurrences, attendance, grading | implemented | `test_teacher_schedule.py`, `test_lessons_quizzes.py` | — |
| Teacher | Content authoring (lessons, quizzes) | implemented | Teachers draft lessons (own or new draft course) and quizzes through `teacher/*` endpoints with the admin console's validation; admins review and publish (overview lists drafts); published items are read-only for teachers; `test_teacher_content.py`, `e2e/teacher-content.mjs` | — |
| Teacher | Voice notes on feedback | implemented | Real recording on the review screen (own recorder), uploaded as private `voice_feedback` media with the feedback; the student plays it through a signed link; parents never get audio; `test_media_submissions.py`, `e2e/loop.mjs` | — |
| Parent | Linked children, sessions, tasks, progress, no audio | implemented | `test_permissions.py`, `e2e/parent.mjs` | — |
| Admin | Portal sign-in | implemented | Real `admin/auth/login`, OTP step, session restore; `e2e/admin.mjs` | — |
| Admin | Users, teachers, parents | implemented | Live sections on `admin/users*`, approval, links, setup links, teacher invitations; `test_admin_people.py`, `e2e/admin-people.mjs` | — |
| Auth | Set-password and invitation pages | implemented | `#/reset`, `#/invite` (`src/screens/auth/LinkPages.tsx`) | Email delivery (pack 23) |
| Admin | Circles, bookings | implemented | `admin/circles*`, `admin/sessions/<id>/cancel`, `admin/bookings*`; `test_admin_scheduling.py`, `e2e/admin-scheduling.mjs` | — |
| Admin | Courses, lessons, enrollments, quizzes | implemented | `admin/courses*`, `admin/lessons*`, `admin/enrollments*`, `admin/tests*`, `admin/questions*` (versioned); `test_admin_content.py`, `e2e/admin-content.mjs`; lesson files (PDF, audio) uploaded privately, type-checked, readable only through signed links once published; unattached uploads purged after 48 h | — |
| Admin | Selection, bulk actions, advanced filters | implemented | Row and page selection, «تحديد جميع النتائج» sent as a validated server filter, sticky bulk bar, typed «حذف» for 10+ destructive records, per-record results, filter drawer and chips, server search and sort, list state in the URL, cards on narrow screens; `POST admin/{resource}/bulk-action` (users, circles, sessions, bookings, courses, lessons, enrollments, tests, questions); people archived, never deleted; delete only for empty drafts (`test_admin_bulk.py`, `e2e/admin-bulk.mjs`) | — |
| Admin | Settings, audit log | implemented | `admin/settings` (password re-entry for sensitive keys), `admin/audit`, public `settings/public` read by the app; `test_admin_settings.py`, `e2e/admin-settings.mjs` | — |
| Admin | Subscriptions | hidden (owner decision: no charge for now) | Section removed from the live portal; demo keeps its sample | Revisit if the academy starts charging (manual payments first) |
| Backend | Auth, roles, CSRF, throttles, audit events | implemented | `test_auth.py`, `test_permissions.py` | — |
| Performance | Load test (prompt 25) | implemented | **Load test** workflow, Cloud Run-sized container (1 CPU, 512 MB): 25→50 active students + teachers + parents, 0 % errors, p95 23 ms, booking race 1 winner of 50, no OOM — [LOADTEST.md](LOADTEST.md) | Re-run on Cloud Run + Neon staging before claiming more |
| CI | Gates | implemented | Backend (PostgreSQL tests, migrations check, deploy check, pip-audit), Web (typecheck, build, PWA/cache checks, npm audit, CSP headers in the production image), **E2E (live mode)**: 16 browser suites over the 7 handbook journeys | — |
| Security | Prompt 24 hardening | implemented | Admin MFA required when deployed; per-account lockout; password-change throttle; shared (database) rate-limit cache; CSP + Permissions-Policy on every response; cross-role sweep over 24 id-bearing endpoints; `pip-audit` + `npm audit` in CI; `test_security.py`, `e2e/admin.mjs` with `MFA_ENFORCED=1` | Owner: turn on two-step verification at next admin sign-in |
| PWA | Installable, offline shell, update prompt | live | Smoke "PWA installable" on production; `e2e/pwa.mjs` (manifest, offline shell, no API data cached, back button); `e2e/pwa-update.mjs` (update never interrupts a recording) — see [PWA_QA.md](PWA_QA.md) | Owner: real-device checklist in PWA_QA.md |
| Deployment | Cloud Run, deploy on merge, migrations before release | live | `deploy-cloudrun.yml` runs green; `/api/ready` ok | — |
| Storage | Private recordings (Cloudflare R2) | live | `/api/ready` → `media_storage: configured`; smoke upload, owner playback, anonymous refused | — |
| Email | Password-reset delivery | live | Gmail SMTP via `deploy/gcp-email.sh`; production `/api/ready` → `email: smtp`; owner confirmed a real reset email and link on 17 October 2026 | — |
| Domain | Custom domain | missing | App served at `halqa-835293468002.europe-west1.run.app` | Optional |
| Recovery | Backups, restore drill | live | Nightly **Backup and restore drill**: production dump restored into an isolated database and verified (first run: 770 KB dump 17 s, restore <1 s, verify 3 s; sign-in, Quran 6,236 ayahs byte-identical, media rows) — [RECOVERY.md](RECOVERY.md) ; encrypted copies kept 30 days since 17 October (`stored=yes`); RPO 24 h, RTO 1 h | — |
| Monitoring | Alerts, uptime, operational signals | implemented | Structured failure events, sign-in signals, hourly `ops_stats`; `deploy/gcp-ops.sh` (9 alert policies, uptime check, Cloud Scheduler); `alert-drill` Ops task; `test_health.py` — [MONITORING.md](MONITORING.md) | Owner: run `deploy/gcp-ops.sh`, then the `alert-drill` |
| Live video | Live sessions | done (meeting link) | The teacher adds a Google Meet, Zoom, Jitsi or Teams participant link; only the booked student gets it, inside the join window; parents cannot join; attendance stays the teacher's action. No video runs inside the app | Pack prompt 19 |
| Commercial | Subscriptions, payments | not planned yet (owner: no charge for now) | — | Manual payments first if charging starts |
| Android | Native APK | not present (by decision) | Capacitor project removed; PWA is the client | Pack prompt 30 only if required |

## Top gaps (user impact × release risk)

1. ~~Admin sign-in (04)~~ and ~~users/teachers/parents (05)~~ — done.
3. ~~Courses/lessons/quizzes authoring (07)~~ — done in the admin console.
4. ~~Admin bookings/circles (06)~~ — done.
5. ~~Settings (08)~~ — done.
6. ~~Password-reset email not delivered (23)~~ — live; real delivery confirmed by the owner (17 October).
7. ~~No tested backup/restore (27)~~ — nightly drill; encrypted copies kept since 17 October.
8. ~~No error tracking or alerting (26)~~ — ready; the owner runs `deploy/gcp-ops.sh` to switch alerts on.
9. ~~Teacher content authoring still sample (07, teacher side)~~ — teachers draft, admins publish.
10. ~~Live video sessions undecided (19)~~ — teacher meeting links, join window enforced.

The admin portal is live; subscriptions are hidden (no charge for now). Prompts 18–29 are done (ayah audio built but off until licensed); what remains needs the owner (`gcp-ops.sh`, real-device QA). Release review: [RELEASE_REVIEW.md](RELEASE_REVIEW.md) (prompt 32).
