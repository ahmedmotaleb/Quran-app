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

## What is real and what is simulated

| Real | Simulated (labelled in the UI) |
| --- | --- |
| Quran text (Tanzil Uthmani via api.alquran.cloud) | Sign-in and sign-up, password reset email |
| Ayah audio (Mishary Alafasy via everyayah.com) | Uploading recordings, the teacher's voice note |
| Microphone recording and playback (MediaRecorder) | Saving bookings, live video, notifications, downloads |

Everything is held in memory and is lost on reload. Quran text is only ever shown from
the API. If it fails to load, the app shows an error state and never placeholder text.

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
  components/            Icon, UI primitives (Badge, Segmented, Chips, Switch, PlayerBar…), Sheet
  screens/auth|student|teacher|parent/
  AppShell.tsx           status bar, nav, data-state views, toast, bottom sheet
  demo/DemoPanel.tsx     prototype control panel (desktop only)
  admin/                 admin portal: data, store, tables, dialogs, settings (lazy-loaded)
  designsystem/          living style guide (lazy-loaded)
  theme/brand.ts         product name and tagline (single source)
```

Times are stored in Riyadh time (the demo's equivalent of UTC) and shown in the user's
chosen timezone (`lib/format.ts → timeIn`). Task status moves
`not_started → in_progress → submitted → reviewed`.

## Backend integration notes

See `project/HANDOFF.md` for the suggested entities. The parts that need a backend are:
authentication and role-based routing, recording upload (`store.submitRec`), booking
persistence and slot locking (`store.confirmBooking`), review submission
(`store.sendReview`), assignments (`store.sendAssign`), live sessions (a WebRTC
provider), notifications, file storage for lessons, and the admin portal's server-side pagination,
linking and approvals.

## Not yet implemented

- Real payments and subscription billing
- Server persistence. Every change is in memory and resets on reload.

## Design handoff

`project/` holds the original Claude Design prototypes and assets. `chats/` holds the
design conversation.
