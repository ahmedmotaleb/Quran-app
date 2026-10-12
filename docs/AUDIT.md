# Repository audit and roadmap (Prompt 02)

Audit date: 11 October 2026. Repository `ahmedmotaleb/Quran-app`, branch `halqa-frontend`,
audited at commit `d39fd5d` (base `main` = `861c249`, README only).

This report describes **what the repository contains**, not what earlier conversations
asked for. "Implemented" means code exists and was exercised in a browser; nothing here is
deployed.

## What exists

| Area | Evidence | Notes |
| --- | --- | --- |
| Frontend | `src/` — React 18.3, TypeScript 5.6, Vite 6, zustand 5 | Arabic RTL mobile app, admin portal (`#/admin`), design system (`#/design-system`) |
| Data | `src/data/demo.ts`, `src/admin/adminData.ts` | **In-memory demo data only.** Nothing persists across reload |
| Backend | none (before Prompt 03) | No API, no database, no server-side auth |
| Quran text | `src/services/quran.ts` | Fetched live from api.alquran.cloud (Tanzil Uthmani). Not imported, versioned or checksummed |
| Audio | `src/services/media.ts` | MediaRecorder works in the browser; "upload" is a timer |
| Android | `android/`, Capacitor 8.5.3, `.github/workflows/android.yml` | Debug APK built in CI (run 38165771100). Not installed on a device. No release keystore |
| Tests | Playwright scripts kept outside the repo | No automated tests are committed yet |

## Feature matrix

States: **implemented** (works end to end with persistence), **UI only** (screen works on
demo data, no backend), **partial**, **missing**, **blocked** (needs an external decision
or credential).

| Feature | State | Where |
| --- | --- | --- |
| Arabic RTL UI, role dashboards | UI only | `src/screens/*`, `src/admin/*` |
| Sign-in / sign-up / recovery | UI only (fake accounts) | `store.doLogin`, `doSignup`, `doForgot` |
| Separate admin sign-in | UI only | `src/admin/adminStore.ts → adminLogin` |
| Server-enforced roles and ownership | missing | — |
| Verified Quran data (import, checksum, license notice) | partial — live API read only | `services/quran.ts` |
| Memorization plans and review schedule | UI only, no spaced review | `store.tasks` |
| Courses, lessons, enrollment | UI only | `LESSONS`, admin lectures |
| Teacher availability and occurrences | UI only, fixed demo week | `generateAvailability` |
| Booking with concurrency protection | missing (client-side "slot taken" simulation) | `store.confirmBooking` |
| Live sessions and attendance | UI only (simulated call) | `screens/student/Live.tsx` |
| Media uploads (private recordings) | missing | `store.submitRec` simulates |
| Recitation review and feedback | UI only | `store.sendReview` |
| Tests and grading | UI only (client-side scoring) | `screens/student/Learn.tsx` |
| Admin console | UI only | `src/admin/*` |
| Parent access | UI only (no verified link) | `screens/parent/ParentHome.tsx` |
| Notifications | missing | toasts only |
| WhatsApp support | missing | — |
| Subscriptions | UI only | admin subscriptions table |
| Security hardening, backups, deployment | missing | — |
| Android APK | partial — debug APK in CI only | `android/`, CI |

## Journeys traced

- **Student:** sign in → home → record → "submit" → feedback. Works on demo data; the
  recording never leaves the device and the teacher sees a simulated queue.
- **Booking:** teacher → slot → review → confirm. The "slot taken" race is a toggle in
  the demo panel, not a database guarantee.
- **Teacher:** review queue → timestamped notes → ratings → send. Updates in-memory
  state only.
- **Admin:** approvals, linking, publishing. In-memory only; lost on reload.

## Decisions taken (owner asked to proceed without stopping)

| Decision | Choice | Reason |
| --- | --- | --- |
| Product name | «الحلقة» (HALQA) | Latest explicit owner instruction, overrides the handbook's «حلقة» |
| Backend | Django 5.2 LTS + Django REST Framework + PostgreSQL 16 | Handbook default for a new project; LTS until April 2028 |
| Frontend | Keep React + TypeScript + Vite | Already built and matches the handbook |
| Default timezone | Africa/Cairo (IANA), DST via tz database | Handbook |
| Student tabs | الرئيسية، تعلمي، الجلسات، تقدمي، حسابي | Handbook |
| Web auth | Django session cookie + CSRF | Handbook (cookie auth needs CSRF) |
| Android auth | Opaque bearer token, hashed server-side, expiring and revocable | WebView origin differs from the API; avoids third-party cookies |
| Media storage | S3-compatible adapter (Cloudflare R2 proposed) | Handbook; **blocked** on credentials |
| Android app ID | `app.halqa.quran` | Must be confirmed before the first Play/public release |

## Change of direction: PWA instead of Android (owner decision)

The owner asked for a PWA instead of an Android app. The Capacitor project, its CI workflow and the
Android-only client code were removed (recoverable from git history). Consequences:

- Prompt 24 (signed release APK) and the `HALQA_KEYSTORE_*` secrets are no longer needed; the
  release artefact is the `dist/` build from `.github/workflows/web.yml`, served over HTTPS.
- Sign-in uses the HttpOnly session cookie everywhere; the bearer-token path stays in the API,
  unused, in case a native client returns.
- iOS: installable via Safari "Add to Home Screen"; web push on iOS needs iOS 16.4+ and an
  installed app (relevant when notifications channels are built).

## Backlog (mapped to the handbook)

1. **03** Backend foundation: project layout, env config, health/readiness, request IDs, seed data, CI on PostgreSQL.
2. **04** Data model: accounts, guardian links, Quran source/surah/ayah, courses, enrollments, assignments, submissions, feedback, availability, occurrences, bookings, attendance, media objects, tests.
3. **05** Auth and permissions: learning vs admin sign-in, sessions + CSRF, native tokens, invitations, guardian verification, object-level checks, rate limits, audit events.
4. **07** Quran import with source version and checksums (needs the Tanzil file; api.alquran.cloud is blocked from the build sandbox).
5. **10–11** Availability → occurrences, booking transactions with row locks and idempotency keys.
6. **06** Replace demo stores with API calls, screen by screen, keeping explicit demo mode.
7. **13–14** Private media uploads (blocked on storage credentials), recitation review.
8. **15, 08, 09, 12, 16** Assessments, review scheduling, courses, live sessions, admin tools.
9. **21–23** Security review, load and end-to-end tests, deployment and backups (blocked on hosting choice).
10. **24** Signed release APK (blocked on keystore) pointing at the deployed HTTPS API.
11. **17–20** Parent dashboard, notifications channels, WhatsApp, subscriptions — when policies and providers exist.

## Environment checklist

| Variable | Purpose | Owner | Status |
| --- | --- | --- | --- |
| `DJANGO_SECRET_KEY` | Django signing | Ops | set per environment, never committed |
| `DATABASE_URL` | PostgreSQL connection | Ops | local dev only |
| `DJANGO_ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, `CORS_ALLOWED_ORIGINS` | Host/origin allowlists | Ops | dev values only |
| `STORAGE_*` (endpoint, bucket, keys) | Private media (R2) | Owner | **missing** |
| `EMAIL_*` | Password recovery | Owner | **missing** — recovery emails are logged in dev only |
| `HALQA_KEYSTORE_*` | Android release signing | — | not needed (PWA) |
| Hosting (API, web, PostgreSQL) | Staging/production | Owner | **not chosen** |

## Checks that could not run here

- Real Quran API and audio (blocked by the sandbox network policy).
- Android SDK builds (blocked locally; run in GitHub Actions instead).
- Device installation, microphone on a real phone.
- Any deployed environment (none exists).

## Smallest next step

Prompt 03: a Django project that starts against PostgreSQL, exposes `/api/health` and
`/api/ready`, persists a real record across restarts and runs its tests in CI on
PostgreSQL.
