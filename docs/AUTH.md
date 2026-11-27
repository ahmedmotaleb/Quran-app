# Sign-in: email and password, Google, Apple, Microsoft (27 Nov 2026)

Email and password sign-in is unchanged. **«المتابعة باستخدام Google / Apple / Microsoft»** is added on top of it.

**A provider's button appears only after its credentials are set on the server.** Until then nothing about it shows,
and it is **not operational until it has been tried on a real device** (checklist below).

**Code:**
- server: `backend/apps/accounts/oidc.py` (OpenID Connect) and `social.py` (accounts, linking, «طرق تسجيل الدخول»,
  devices);
- app: `src/screens/auth/Social.tsx`.

## How it works
- **OpenID Connect, authorization code flow, run on the server.**
  - **PKCE (S256)** is used for Google and Microsoft. Apple uses its signed client secret.
  - A random **state** is bound to the browser that started it, by an HttpOnly cookie. It works once, for 10 minutes.
  - A **nonce** is checked inside the ID token.
- **The ID token is verified on the server:**
  - signature against the provider's published keys (JWKS);
  - issuer (for Microsoft, the token's own tenant);
  - audience (our client id);
  - expiry;
  - nonce.
- **No provider token is stored or sent to the app.** Client secrets live only in Secret Manager.
- **An email counts only when the provider verified it:**
  - Google: `email_verified`;
  - Apple: `email_verified`, including private-relay addresses;
  - Microsoft: verified for personal accounts, or for work accounts when the tenant asserts it (`xms_edov`).
- **The callback never signs in directly.** It gives the app a one-time ticket in the URL fragment, redeemed by the
  same browser for the app's normal session (web cookie or app token). This works the same in the PWA, the Android
  app (Chrome), iPhone Safari and desktop browsers. The flow uses the system browser, never a WebView.
- **Rate limited** like the other sign-in endpoints (`THROTTLE_AUTH`). Every step is **audited** (`auth.oauth_*`),
  without tokens or claims.

### Accounts
- **A connected provider account opens only its own HALQA account.** The table `accounts_auth_identity` is unique on
  (provider, subject) and allows one account per provider per user.
- **Same email, not connected:** never merged automatically.
  - If the provider verified the email, a one-time confirmation link (30 minutes) is emailed to the HALQA account's
    address. Opening it connects the provider and signs in.
  - Otherwise the person signs in with their password and connects from «حسابي ← طرق تسجيل الدخول».
- **New person** (provider-verified email only, public sign-up open) chooses **طالب / معلم / ولي أمر**:
  - **Student:** as before, then the usual onboarding.
  - **Teacher:** created **unapproved**; the existing admin approval decides, and the admins are notified.
  - **Parent:** sees only children an admin links.
  - **Admins are never created here.** Admin accounts cannot sign in with a provider; they keep password plus
    two-step code in the admin portal.
- **«طرق تسجيل الدخول»:**
  - connect or disconnect each provider (the last way in cannot be removed);
  - set a password, which needs a sign-in within the last 15 minutes;
  - list the signed-in devices, sign one out, or sign out of all others.
  - Ending a device's session also removes that device's push registration, so its notifications stop.
- **Existing data is untouched:** connecting only adds a row. Progress, teacher links, sessions, attendance,
  evaluations, notification settings and parent links stay on the same user.

## Callback addresses (register exactly these)
| Provider | Callback URL |
| --- | --- |
| Google | `https://<APP_URL host>/api/v1/auth/oauth/google/callback` |
| Microsoft | `https://<APP_URL host>/api/v1/auth/oauth/microsoft/callback` |
| Apple | `https://<APP_URL host>/api/v1/auth/oauth/apple/callback` |

`<APP_URL host>` is the address in the service's `APP_URL`, for example
`halqa-835293468002.europe-west1.run.app`. `deploy/gcp-social-login.sh` prints the exact addresses.

## Environment variables
| Variable | Secret? | Meaning |
| --- | --- | --- |
| `AUTH_GOOGLE_CLIENT_ID` | no | Google OAuth client ID. The Calendar client may be reused: add the callback above to it, then set these two to its values |
| `AUTH_GOOGLE_CLIENT_SECRET` | **yes** (Secret Manager) | Google client secret |
| `AUTH_MICROSOFT_CLIENT_ID` | no | Entra ID application (client) ID |
| `AUTH_MICROSOFT_CLIENT_SECRET` | **yes** | the client secret's **value** |
| `AUTH_MICROSOFT_TENANT` | no | `common` (personal and work, default), `consumers`, `organizations`, or a tenant id |
| `AUTH_APPLE_CLIENT_ID` | no | the **Services ID** (for example `app.halqa.web`) |
| `AUTH_APPLE_TEAM_ID` | no | Apple Developer team id |
| `AUTH_APPLE_KEY_ID` | no | the Sign in with Apple key id |
| `AUTH_APPLE_PRIVATE_KEY` | **yes** | the `.p8` key (PEM) |
| `AUTH_OAUTH_FAKE` | — | development and CI stand-in provider only; ignored when deployed |

Run `bash <(curl -fsSL https://raw.githubusercontent.com/ahmedmotaleb/Quran-app/main/deploy/gcp-social-login.sh)` in
Cloud Shell. It stores the secrets in Secret Manager and sets the rest.

## Provider setup (owner)
### Google (first)
1. Google Cloud console → APIs & Services → **OAuth consent screen**:
   - app name «الحلقة», support email;
   - scopes `openid`, `email`, `profile`;
   - publish the app («In production») so any Google account can sign in.
2. **Credentials** → Create credentials → **OAuth client ID** → **Web application**:
   - Authorized redirect URI: the Google callback above.
   - (Or add that URI to the existing Calendar client.)
3. Run the script and enter the client ID and secret.

### Microsoft
1. Microsoft Entra admin center → App registrations → **New registration**:
   - supported accounts: «Accounts in any organizational directory and personal Microsoft accounts»;
   - Redirect URI: **Web**, the Microsoft callback above.
2. **Certificates & secrets** → New client secret: copy the **Value**.
3. **Token configuration** (optional): add the `email` optional claim.
4. Run the script.

### Apple (needs the paid Apple Developer Program)
1. Apple Developer → Identifiers:
   - an **App ID** with «Sign in with Apple»;
   - a **Services ID** (for example `app.halqa.web`) with «Sign in with Apple» configured:
     - domain: the APP_URL host;
     - Return URL: the Apple callback above.
2. Keys → a new key with «Sign in with Apple»: download the `.p8` and note its **Key ID** and your **Team ID**.
3. Upload the `.p8` to Cloud Shell and run the script.

## Real-device checklist (owner — not run by Claude)
Fill in ✅ or ❌ with the device and browser.

| # | Check | Android PWA | Android Chrome | iPhone Safari | iPhone Home-Screen app | Desktop |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Google: a new person signs up, picks طالب, reaches onboarding | | | | | |
| 2 | Google: signs in again later (same account, no duplicate) | | | | | |
| 3 | Microsoft: sign up and sign in (a personal account) | | | | | |
| 4 | Apple: sign up and sign in (including «Hide My Email») | | | | | |
| 5 | Existing password account: «حسابي ← ربط Google» then sign in with Google opens the same account and data | | | | | |
| 6 | A provider email equal to an existing account: a confirmation email arrives; the link connects and signs in | | | | | |
| 7 | Teacher sign-up: the account waits for admin approval; admins get the notice | | | | | |
| 8 | After a provider sign-in, notifications still arrive (no new permission prompt) | | | | | |
| 9 | Sign out, then sign in as another account on the same phone: the first account's notifications stop | | | | | |
| 10 | «تسجيل الخروج من الأجهزة الأخرى» signs the other phone out | | | | | |

The iPhone Home-Screen app opens the provider in Safari's sheet. If it comes back signed out, finish in Safari;
that is an iOS cookie-isolation limit.

## Tests (automated)
- **`backend/tests/test_social_login.py` (20):**
  - sign-up per role; admin role refused; teacher unapproved; parent without children;
  - no duplicate account; the native token;
  - unverified email, closed sign-up;
  - no merge on an email match, then the mailbox confirmation;
  - connect, and refusing another user's provider account; data kept;
  - admin and suspended accounts refused;
  - state used once and bound to the browser; cancel; unconfigured providers hidden;
  - last way in protected; password set after a fresh sign-in;
  - devices: list, sign out one or the others (their push removed); logout;
  - ID token rules for Google (audience, issuer, nonce, expiry, unsigned), Microsoft (issuer per tenant, single
    tenant, email trust) and Apple (ES256 client secret, form post, name).
- **`e2e/social-login.mjs` (10):** the whole journey with the development stand-in provider, which signs real ID
  tokens, so the server's checks run.
