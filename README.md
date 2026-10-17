# الحلقة | HALQA — Quran learning app

Arabic Quran memorization and Tajweed LMS: React + TypeScript (Vite) installable PWA, and a
Django + DRF + PostgreSQL API in `backend/`. Production runs on Google Cloud Run (see
`docs/DEPLOY.md`); the current, evidence-based status of every area is in `docs/STATUS.md`.

**Current state (17 October 2026, `main`):** the student, teacher and parent apps and the admin portal
(`#/admin`) run on the real API in production: https://halqa-835293468002.europe-west1.run.app. The
installable client is a PWA; there is no native Android app (not required). Owner decisions in force:
no charging yet (subscriptions hidden), ayah audio off until a licensed source is approved, recordings deleted
48 hours after the teacher's review, live classes through teacher-provided meeting links. Remaining work needs
the owner (see `docs/RELEASE_REVIEW.md`).

The mobile app (student, teacher and parent) built from the Claude Design handoff in
`project/Halqa App.dc.html`. It is Arabic-first and fully RTL. The stack is React 18,
TypeScript and Vite.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build
```

On screens 760px and wider, the app opens inside a phone frame next to the prototype
control panel. The panel lets you jump between roles, run the four guided flows, force
loading/empty/error/offline states, simulate a failed upload or a slot that is no longer
free, and switch between 360, 390 and tablet widths. On narrower screens the app runs
full-screen and respects the safe areas.

Demo accounts (password `halqa123`): `yousef@halqa.app` (student), `teacher@halqa.app`,
`parent@halqa.app`. Public sign-up only ever creates a student account.

## Admin portal (`#/admin`)

**Live:** in live mode, sign-in (with enforced two-step verification), the overview, students, teachers,
parents, circles, bookings, lectures (courses, lessons, enrollments, lesson files), quizzes, review and publishing
of teacher drafts, settings (including the support email) and the audit log run on the real API. Subscriptions
are hidden in the live portal (owner decision: no charge for now). The description below is of the demo portal,
which keeps its sample data.

The desktop admin portal has its own sign-in (demo: `admin@halqa.app` / `halqa123`). Admin
accounts can't sign in to the mobile app, and other accounts can't sign in to the portal.
You reach it from «دخول الإدارة» on the login screen, or from the demo panel. Its sidebar
follows the brief:
- **Overview:** KPIs, pending actions per section, and today's sessions.
- **Students:** about 185 demo accounts with search, a level filter, status filters and
  pagination. Each student opens a detail drawer. Approve-and-link requires a teacher.
  Add/edit and suspend (with confirmation) are available.
- **Teachers:** approve or reject, suspend, and a detail drawer (students, circles, content).
- **Parents:** link children (both sides of the link stay in sync), add/edit, suspend.
- **Circles:** create as draft, edit (capacity is validated), publish, suspend.
- **Bookings:** filter by teacher and status, cancel with confirmation.
- **Lectures / Quizzes:** publish, return to teacher, unpublish, create a draft.
- **Subscriptions:** activate, plus an expired filter.
- **Settings:** organisation, timezone, session durations, cancellation window,
  notification switches. Changes stay in a draft until saved, and errors show beside
  each field.

On narrow screens the sidebar becomes a top bar with a horizontal section list, and
tables scroll sideways.

## Brand name

The product name lives in `src/theme/brand.ts` (`BRAND.ar`, `BRAND.en`, `BRAND.tagline`).
The full logo is the emblem image (`public/assets/halqa-mark.png`, which has no lettering)
plus a wordmark drawn as live text by `components/Logo.tsx`. Changing the name in that one
file updates the logo, page titles and in-app text.

## Design system (`#/design-system`)

A style guide rendered with the app's real tokens and components (colours, type,
buttons, badges, fields, tabs/chips/switch, icons, principles). Its Quran samples are
loaded from the API like everywhere else, never hand-typed.

## Deploying

See **[docs/DEPLOY.md](docs/DEPLOY.md)**: Google Cloud Run (one Docker image serving the PWA and the
API, free tier) + Neon (free PostgreSQL) + Cloudflare R2 (recordings). `deploy/gcp-setup.sh` is the
one-time Cloud Shell setup; `.github/workflows/deploy-cloudrun.yml` deploys every merge to `main`;
`.github/workflows/ops.yml` imports the Quran text and creates the first admin.

## Installable app (PWA)

The mobile app is a Progressive Web App: the same build is a website and an app people install
from the browser — no app store. (The earlier Capacitor/Android project was removed; it is in git
history if a store build is ever needed.)

- **Install:** Android/desktop Chrome or Edge offer "Install"; the app also shows
  «ثبّت التطبيق على جهازك» in the account screen. iPhone/iPad: Safari → Share → «إضافة إلى الشاشة الرئيسية».
- **Offline:** the app shell (code, styles, icons, fonts) is cached so it opens without a
  connection. **API responses and recordings are never cached** — learner data must not persist on
  shared devices — so screens that need data show their error/offline state.
- **Updates:** a new version installs in the background and the app shows «يتوفر إصدار جديد» with
  «حدّث الآن»; it never reloads on its own (so a recording in progress is not lost).
- **Back button:** in-app screens are pushed to browser history, so the phone's back gesture walks
  back through the app instead of closing it.
- **Hosting requirement:** HTTPS (service workers and the microphone need a secure origin). Serve
  `dist/` with `index.html` as the fallback for unknown paths, and send `sw.js` with
  `Cache-Control: no-cache` so updates are picked up.
- **Checks:** `.github/workflows/web.yml` (typecheck, build, manifest, no duplicate precache entries,
  no API caching) and `e2e/pwa.mjs` (Chrome installability, offline launch, caches contain no
  API data, back button).

## What is real and what is simulated

The app runs in one of two modes, chosen at build time by `VITE_API_BASE_URL`:

- **Demo mode** (unset): the original prototype. Everything is held in memory and resets on
  reload. Sign-in, bookings, uploads and notifications are simulated and labelled.
- **Live mode** (set): the student journey talks to the Django API in `backend/`.

Everything in live mode runs on the API; no screen shows sample content.

| Area | Live mode |
| --- | --- |
| Accounts | Sign-in, sign-up (student only), sign-out, session restore, password reset by email (Gmail SMTP) |
| Student | Onboarding, Today plan, tasks, recording upload and submission, teacher feedback (audio deleted 48 h after review), spaced-repetition reviews, progress, inbox |
| Mushaf | Verified Tanzil text from the server, bookmarks with private labels, reading position across devices, text size, ranges; ayah audio **off** until a licensed source is configured (`AYAH_AUDIO_URL`) |
| Booking | Teacher directory, real open slots, booking, cancelling, rescheduling; live sessions open the teacher's Google Meet/Zoom/Jitsi/Teams link inside the join window |
| Teacher | Students, new tasks, review queue, scores, timed notes, voice notes, schedule, attendance, meeting links, quiz grading, content drafts (published by admins) |
| Parent | Linked children only: sessions, attendance, tasks, progress, weekly summary, latest feedback (no audio, cannot join sessions) |
| Notifications | In-app inbox and bell; hourly reminders; Web Push built, off until VAPID keys are set (`deploy/gcp-push.sh`) |

The app uses the HttpOnly session cookie + CSRF token; no token is stored in the browser. Bookings send an `Idempotency-Key`, so a retried tap
never double-books. Server errors are shown in Arabic as the server wrote them.

Quran text: in live mode it comes only from the backend's imported, checksum-verified copy
(`manage.py import_quran`, see `backend/README.md`); until that import runs, the Mushaf says
the verified source is unavailable. Demo mode (the design prototype only, not deployed) reads Tanzil Uthmani via
api.alquran.cloud and plays sample audio from everyayah.com.
Either way, a failure shows an error state and never placeholder text.

### Running live mode locally

```bash
cd backend && cp ../.env.example .env   # set DATABASE_URL etc.
.venv/bin/python manage.py migrate && .venv/bin/python manage.py seed_dev
.venv/bin/python manage.py runserver     # :8000
cd .. && VITE_API_BASE_URL=/ npm run dev  # Vite proxies /api → :8000
```

Seeded accounts (development only): `yousef@halqa.app`, `teacher@halqa.app`,
`parent@halqa.app`; password from `SEED_PASSWORD` (default `halqa123`). Admins sign in at
`#/admin` only.

## Layout

```
src/
  theme/tokens.ts        colours, fonts, radii (design tokens)
  data/types.ts          domain models (Assignment, Review, Session, Slot…)
  data/demo.ts           demo data layer — swap for API calls
  services/quran.ts      live: the server's verified text; demo: alquran.cloud + everyayah.com
  services/media.ts      shared <audio>, Mushaf audio, MediaRecorder
  store/store.ts         app state (zustand) + actions: navigation, recorder, booking, reviews…
  store/selectors.ts     derived data (sessions in the user's timezone, etc.)
  store/live.ts          live-mode actions backed by the API
  api/client.ts          fetch wrapper: base URL, auth, CSRF, timeout, retries, errors
  api/endpoints.ts       typed endpoints + adapters to the screens' data shapes
  components/            Icon, UI primitives (Badge, Segmented, Chips, Switch, PlayerBar…), Sheet
  screens/auth|student|teacher|parent/
  AppShell.tsx           status bar, nav, data-state views, toast, bottom sheet
  demo/DemoPanel.tsx     prototype control panel (desktop only)
  admin/                 admin portal: data, store, tables, dialogs, settings (lazy-loaded)
  designsystem/          living style guide (lazy-loaded)
  theme/brand.ts         product name and tagline (single source)
  pwa/                   install prompt, update banner (service worker via vite-plugin-pwa)
```

In live mode times are real instants from the server, shown in the user's IANA timezone
(`lib/time.ts`). Demo data keeps hours in Riyadh time (`lib/format.ts → timeIn`). Task
status moves `not_started → in_progress → submitted → reviewed | needs_repeat`.

## Not implemented, by decision or pending the owner

- Subscriptions and payments (owner: no charge for now; section hidden)
- Ayah audio in production (built; off until a licensed source is approved)
- Video inside the app (sessions use the teacher's meeting link)
- Native Android app (the PWA is the mobile client)
- Owner checks still open: alerts (`deploy/gcp-ops.sh`), kept encrypted backups
  (`BACKUP_PASSPHRASE`), real-device PWA QA (`docs/PWA_QA.md`)

## Design handoff

`project/` holds the original Claude Design prototypes and assets. `chats/` holds the
design conversation.
