# الحلقة | HALQA — Quran learning app

Arabic Quran memorization and Tajweed LMS. The planned production stack is Django,
PostgreSQL, a responsive Arabic interface and Android packaging. This repository
currently holds the **frontend**; the Django/PostgreSQL backend is not built yet (see
"Backend integration notes" below for the contract it needs to fulfil).

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

The desktop admin portal has its own sign-in (`admin@halqa.app` / `halqa123`). Admin
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

## Android app (Capacitor)

The same web app is packaged as an Android APK with Capacitor 8 (`android/`, app ID
`app.halqa.quran`, min SDK 24, target/compile SDK 36). The installed app always runs
full-screen (the desktop demo frame is web-only). It uses the hardware back button for
in-app navigation and draws edge-to-edge with safe-area padding. Recording asks for the
microphone permission at runtime.

**Toolchain:** Node 22, JDK 21, Android SDK platform 36 + build-tools 36.0.0 (Android
Gradle Plugin 8.13, Gradle 8.14.3 via the wrapper).

```bash
npm run build && npx cap sync android
cd android && ./gradlew assembleDebug     # app/build/outputs/apk/debug/app-debug.apk
```

**Release signing:** `assembleRelease` reads `HALQA_KEYSTORE_FILE`, `HALQA_KEYSTORE_PASSWORD`,
`HALQA_KEY_ALIAS` and `HALQA_KEY_PASSWORD` from the environment and **fails** if any is
missing. It never falls back to debug signing. Keep the keystore out of Git (`*.jks` is
ignored) and back it up: every future update must be signed with the same key.

**CI:** `.github/workflows/android.yml` builds the debug APK on every push, records its
SHA-256 and checks that an unsigned release is refused. If the repository secrets
`HALQA_KEYSTORE_BASE64` (base64 of the .jks), `HALQA_KEYSTORE_PASSWORD`, `HALQA_KEY_ALIAS`
and `HALQA_KEY_PASSWORD` are set, it also builds the signed release, verifies the
signature with `apksigner` and uploads it with its hash. Download APKs from the run's
**Artifacts**.

**Backend:** there is no API yet. When the Django backend exists, the app must point to
its HTTPS origin (never localhost or a live-reload URL in a shipped build).

### تثبيت التطبيق على أندرويد (نسخة تجريبية)
1. افتح صفحة **Actions** في المستودع، واختر آخر تشغيل ناجح لـ «Android APK».
2. نزّل الملف `halqa-debug-apk` من قسم **Artifacts** ثم فك ضغطه.
3. انقل ملف ‎.apk‎ إلى الهاتف وافتحه، واسمح بـ«تثبيت التطبيقات من مصادر غير معروفة» عند الطلب.
4. عند أول تسجيل للتلاوة سيطلب التطبيق إذن الميكروفون؛ اختر «السماح».

هذه نسخة اختبار موقّعة بمفتاح التطوير، وكل بياناتها تجريبية. لا تُوزَّع على المستخدمين.

## What is real and what is simulated

The app runs in one of two modes, chosen at build time by `VITE_API_BASE_URL`:

- **Demo mode** (unset): the original prototype. Everything is held in memory and resets on
  reload. Sign-in, bookings, uploads and notifications are simulated and labelled.
- **Live mode** (set): the student journey talks to the Django API in `backend/`.

| Live mode: connected to the API | Live mode: still sample content (banner shown) |
| --- | --- |
| Sign-in, sign-up (student only), sign-out, session restore, password-reset request | Teacher and parent apps |
| Onboarding answers, profile timezone | Recording upload (needs object storage; the app says so) |
| Student tasks and their statuses | Teacher feedback details, progress, lessons, quizzes |
| Teacher directory, real open slots, booking, cancelling, rescheduling | Live video sessions |

Web uses the session cookie + CSRF token; Android stores a bearer token in app-private
storage (`@capacitor/preferences`). Bookings send an `Idempotency-Key`, so a retried tap
never double-books. Server errors are shown in Arabic as the server wrote them.

Quran text: in live mode it comes only from the backend's imported, checksum-verified copy
(`manage.py import_quran`, see `backend/README.md`); until that import runs, the Mushaf says
the verified source is unavailable. Demo mode reads Tanzil Uthmani via api.alquran.cloud.
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
  services/quran.ts      alquran.cloud + everyayah.com
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
  lib/native.ts          Android: back button, system bar style (no-op on web)
android/                 Capacitor Android project
```

In live mode times are real instants from the server, shown in the user's IANA timezone
(`lib/time.ts`). Demo data keeps hours in Riyadh time (`lib/format.ts → timeIn`). Task
status moves `not_started → in_progress → submitted → reviewed | needs_repeat`.

## Backend integration notes

See `project/HANDOFF.md` for the suggested entities. The parts that need a backend are:
authentication and role-based routing, recording upload (`store.submitRec`), booking
persistence and slot locking (`store.confirmBooking`), review submission
(`store.sendReview`), assignments (`store.sendAssign`), live sessions (a WebRTC
provider), notifications, file storage for lessons, and the admin portal's server-side pagination,
linking and approvals.

## Not yet implemented

- Real payments and subscription billing
- Server persistence for the teacher, parent and admin apps (they still use demo data).

## Design handoff

`project/` holds the original Claude Design prototypes and assets. `chats/` holds the
design conversation.
