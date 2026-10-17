# PWA release QA

The PWA is the mobile client. This page separates what is **verified automatically** (desktop Chromium, so not
proof of phone behaviour) from what still needs **real devices**. Prompt 29 rule: mobile readiness is not
inferred from emulation.

## Verified automatically

| Check | Evidence | Where |
| --- | --- | --- |
| Manifest: Arabic name, `dir: rtl`, `lang: ar`, `display: standalone`, start URL, theme/background, 192/512 + maskable icons served as PNG | `e2e/pwa.mjs`, `web.yml` manifest check | CI (every PR) |
| Chrome reports the app installable | `e2e/pwa.mjs`; smoke "PWA installable" | CI + production after every deploy |
| Offline launch of the app shell | `e2e/pwa.mjs` (offline reload shows the app) | CI |
| No API responses or recordings in any cache | `e2e/pwa.mjs` inspects Cache Storage; `web.yml` fails if the service worker has an `/api` runtime rule; Workbox precaches only `js, css, html, png, svg, woff2` | CI |
| Offline states on data screens | Home shows «غير متصل: هذه آخر خطة محمّلة…»; uploads are refused offline (recording kept, retry offered); inbox keeps the last count | code + `e2e/live.mjs` |
| Update banner; "update now" never reloads over a recording | `e2e/pwa-update.mjs`: a new version is published mid-recording, "حدّث الآن" waits (notice moves to the top, taps pass through), the recording is submitted, then the app updates itself and the submission is on the server | CI |
| Back button walks in-app history and never leaves the app | `e2e/pwa.mjs` (hardware back + on-screen back) | CI |
| Microphone recording, upload and submission (fake microphone) | `e2e/loop.mjs`, `e2e/pwa-update.mjs` | CI |
| Session survives closing and reopening | Session cookie lasts 14 days (`SESSION_COOKIE_AGE`); `e2e/live.mjs`/`admin.mjs` reload and stay signed in | CI |
| Install help in Arabic | Account → «ثبّت التطبيق على جهازك»: the system prompt where the browser supports it, Safari steps on iPhone | code |
| Safe areas, RTL, on-screen keyboard | `viewport-fit=cover`, `env(safe-area-inset-*)` on the shell, sheets and banners; `interactive-widget=resizes-content`; every screen is RTL | code + 390×844 screenshots |
| Strict Content-Security-Policy does not block the app | Built app served by Django with the real CSP: no violations, fonts load | `docs/STATUS.md` prompt 24 |

## Needs real devices (owner)

Not tested: there are no physical devices in this environment. Use the production address. Install it from the
browser and run each row. Write ✅ or ❌, plus the device and OS version.

| # | Check | Android Chrome | Android Edge/Samsung | iPhone Safari | iPad Safari |
| --- | --- | --- | --- | --- | --- |
| 1 | Install (Android: menu → *Install app*; iOS: Share → *Add to Home Screen*); icon and Arabic name look right | | | | |
| 2 | Opens full-screen (no browser bar), status bar colour matches, nothing hidden under the notch or home bar | | | | |
| 3 | Sign in, close the app fully, reopen: still signed in | | | | |
| 4 | Record 20 s after install: microphone permission prompt appears in Arabic context, recording plays back, submit works | | | | |
| 5 | Lock the screen while recording, unlock: recording state is clear (stopped or continuing, never silently lost) | | | | |
| 6 | Airplane mode, reopen: app shell opens, Home shows the offline notice, submitting a recording is refused with a retry | | | | |
| 7 | Android back gesture / iOS edge swipe goes back one screen and does not leave the app from inner screens | | | | |
| 8 | Keyboard on the sign-in and notes fields does not cover the input or the button | | | | |
| 9 | Phone font size set to largest: text wraps, no clipped buttons, Mushaf text readable | | | | |
| 10 | Mushaf: text is right-to-left with correct ayah markers; play is disabled with «التلاوة الصوتية متوقفة…» (audio off until licensed) | | | | |
| 11 | After the next deploy: "يتوفر إصدار جديد" appears; "حدّث الآن" updates (and waits if a recording is in progress) | | | | |

Known platform limits:
- **iOS PWA:** push notifications only work on iOS 16.4+ for installed apps. Web Push is built but off until VAPID keys are set (`deploy/gcp-push.sh`).
- **Recording format:** Safari records `audio/mp4`. The server accepts it (`apps/media/services.py`
  `AUDIO_TYPES`), but this must be confirmed on a device (row 4).
