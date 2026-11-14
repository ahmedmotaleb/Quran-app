# HALQA on Android: the installable app and the Play Protect warning (14 Nov 2026)

## What the warning means and where it comes from

Play Protect's «This app was built for an older version of Android and doesn't include the latest privacy
protections» is shown for an APK whose **targetSdkVersion is old**. Android 14 and later refuse to install anything
below API 23 at all.

**The blocked APK was not built from this repository.**
- This repository has no Android build today. The owner chose the PWA as the mobile client (README, AUDIT).
- The only Android project it ever had (Capacitor, 11 Oct 2026, removed the same day) targeted **API 36**, so it
  would not produce this warning.
- It never produced a release APK: there was no keystore, and its CI only built a debug APK.

An APK carrying this warning was most likely made with a "website to APK" converter or an old template that targets
an old Android version.

**The PWA does not get this warning.** Installing HALQA from Chrome («تثبيت التطبيق» / Install app) makes Chrome
mint a WebAPK signed by Google. That is the supported install today and needs no APK file.

## The new Android app (android/)

When an APK or a Play listing is needed, `android/` is a **Trusted Web Activity**: a thin launcher that opens the
HALQA site full-screen in the user's Chrome. The code, sign-in cookie, Web Push, audio and microphone are the PWA's.
No WebView and no copy of the web app inside the APK, so there is nothing to keep in sync.

| Setting | Value |
| --- | --- |
| Wrapper | Trusted Web Activity (`com.google.androidbrowserhelper:androidbrowserhelper:2.5.0`) |
| applicationId | `app.halqa.quran` |
| compileSdk / targetSdk | **36** (Android 16; the level Google Play requires from 31 Aug 2026) |
| minSdk | 24 (Android 7.0) |
| Android Gradle Plugin / Gradle / Java | 8.13.0 / 8.14.3 / 17 |
| Permissions | `POST_NOTIFICATIONS` only (Android 13+ runtime permission, asked once through TWA notification delegation) |
| Not requested | INTERNET (Chrome loads the site), microphone (Chrome asks per site when recording), storage, location, phone, contacts |
| Network | `usesCleartextTraffic=false`; https only |
| Backups | `allowBackup=false`, data extraction rules exclude everything (the app stores nothing itself) |
| App Links | `autoVerify` for `https://<host>/`; verified by `/.well-known/assetlinks.json` (served by the backend from `ANDROID_CERT_SHA256`) |
| Signing | Release only with the owner's keystore (CI secrets). v2 and v3 signatures. Never a debug key on a release |
| Release build | `minifyEnabled` and `shrinkResources` |

## Making a signed release (owner)

1. **Create the signing key once:** `bash deploy/android-keystore.sh` (Cloud Shell or your computer). It prints the
   four GitHub secrets to add and the public SHA-256 fingerprint. Keep `halqa-release.jks` and its password safe:
   losing them means no further updates to the same app.
2. **Publish the fingerprint:** `gcloud run services update halqa --region europe-west1 --update-env-vars
   ANDROID_CERT_SHA256=<fingerprint>`.
   - `https://<host>/.well-known/assetlinks.json` then returns it.
   - If you later upload to Google Play with Play App Signing, add Google's app-signing fingerprint too
     (comma-separated).
3. **Build:** GitHub → Actions → **Android (TWA)** → Run workflow.
   - The run checks the signature with apksigner and that targetSdk is 36, then prints the permissions.
   - The APK and AAB are in the run's artifacts for 30 days.

## Real-device checklist (owner — not run by Claude)

Write ✅/❌ with the phone model and Android version. An emulator does not count for row 2.

| # | Check | Android 13 | 14 | 15 | 16 |
| --- | --- | --- | --- | --- | --- |
| 1 | Install the signed APK from the CI artifact: Android shows no "built for an older version of Android" warning | | | | |
| 2 | Play Protect does not block the install (a "scan the app" prompt for a sideloaded app is normal; a block or an "older version" warning is not) | | | | |
| 3 | The app opens HALQA full-screen, with no browser address bar (if a bar shows, assetlinks.json is not matching yet) | | | | |
| 4 | Sign in; close the app; reopen: still signed in | | | | |
| 5 | Notifications: Android asks once («السماح بالإشعارات»); a test notification from the admin portal arrives with the app closed | | | | |
| 6 | Quran audio plays and keeps playing with the screen locked; the lock-screen controls work | | | | |
| 7 | Recording: Chrome asks for the microphone for the HALQA site; a recitation uploads | | | | |
| 8 | A HALQA link from WhatsApp opens in the app (App Links) | | | | |

## Remaining limits
- A sideloaded APK (outside Google Play) can still get Play Protect's general scan prompt for unknown apps. That
  is not the "older version" warning and must not be bypassed. Publishing on Google Play (AAB) avoids it.
- The TWA needs Chrome, or another browser that supports TWAs. Without one it falls back to a Custom Tab with an
  address bar.
