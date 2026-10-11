# حَلْقة | HALQA — Quran learning app

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
```

Times are stored in Riyadh time (the demo's equivalent of UTC) and shown in the user's
chosen timezone (`lib/format.ts → timeIn`). Task status moves
`not_started → in_progress → submitted → reviewed`.

## Backend integration notes

See `project/HANDOFF.md` for the suggested entities. The parts that need a backend are:
authentication and role-based routing, recording upload (`store.submitRec`), booking
persistence and slot locking (`store.confirmBooking`), review submission
(`store.sendReview`), assignments (`store.sendAssign`), live sessions (a WebRTC
provider), notifications, file storage for lessons, and the admin portal.

## Not yet implemented

- The desktop admin portal (`project/Halqa Admin.dc.html`)
- The standalone design-system page (`project/Halqa Design System.dc.html`)

## Design handoff

`project/` holds the original Claude Design prototypes and assets. `chats/` holds the
design conversation.
