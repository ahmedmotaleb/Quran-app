"""OpenID Connect sign-in with Google, Apple and Microsoft (owner request, 27 Nov 2026). Server side only.

Flow: authorization code with PKCE (S256) where the provider supports it (Google, Microsoft; Apple uses its signed
client secret), a random `state` bound to this browser by a cookie, and a `nonce` echoed inside the ID token.
- `begin()` stores {provider, intent, nonce, PKCE verifier, browser binding, user for «ربط»} in the shared cache for
  STATE_TTL and returns the provider's authorization URL.
- `finish()` takes the callback: the state must exist, be unused and match this browser's cookie; the code is
  exchanged at the provider's token endpoint with the client secret (never sent to the app); the ID token is verified
  here: signature against the provider's published keys (JWKS), issuer, audience = our client id, expiry, and nonce.
  Only then are its claims used. A provider's email counts as verified only when the provider says so.
The app never sees provider tokens; HALQA keeps none of them (sign-in needs only the verified identity).

Development / CI: provider "fake" (settings.AUTH_OAUTH_FAKE, refused when deployed) is an in-process identity
provider that signs real RS256 ID tokens with a local key, so the same verification code runs in tests.
"""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
from dataclasses import dataclass
from urllib.parse import urlencode

import jwt
import requests
from django.conf import settings
from django.core.cache import cache

STATE_TTL = 600            # seconds to complete the provider's page
LEEWAY = 60                # clock skew allowed when checking ID token times
BIND_COOKIE = "halqa_oauth"
MS_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad"   # personal Microsoft accounts (their emails are verified)


class OidcError(Exception):
    """`code` is safe to show/log (no tokens, no claims)."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass
class Identity:
    provider: str
    subject: str
    email: str
    email_verified: bool
    name: str


@dataclass(frozen=True)
class Provider:
    key: str
    label: str
    authorize: str
    token: str
    jwks: str
    issuers: tuple[str, ...]
    scope: str
    pkce: bool = True
    form_post: bool = False


def _tenant() -> str:
    return settings.AUTH_MICROSOFT_TENANT or "common"


def providers() -> dict[str, Provider]:
    t = _tenant()
    return {
        "google": Provider("google", "Google", "https://accounts.google.com/o/oauth2/v2/auth", "https://oauth2.googleapis.com/token",
                           "https://www.googleapis.com/oauth2/v3/certs", ("https://accounts.google.com", "accounts.google.com"),
                           "openid email profile"),
        "microsoft": Provider("microsoft", "Microsoft", f"https://login.microsoftonline.com/{t}/oauth2/v2.0/authorize",
                              f"https://login.microsoftonline.com/{t}/oauth2/v2.0/token",
                              f"https://login.microsoftonline.com/{t}/discovery/v2.0/keys", (), "openid email profile"),
        "apple": Provider("apple", "Apple", "https://appleid.apple.com/auth/authorize", "https://appleid.apple.com/auth/token",
                          "https://appleid.apple.com/auth/keys", ("https://appleid.apple.com",), "name email", pkce=False, form_post=True),
        "fake": Provider("fake", "Development", "/api/v1/auth/oauth/fake/authorize", "fake", "fake", ("halqa-fake-idp",), "openid email profile"),
    }


def client_id(p: str) -> str:
    return {"google": settings.AUTH_GOOGLE_CLIENT_ID, "microsoft": settings.AUTH_MICROSOFT_CLIENT_ID,
            "apple": settings.AUTH_APPLE_CLIENT_ID, "fake": "halqa-dev" if settings.AUTH_OAUTH_FAKE else ""}.get(p, "")


def configured(p: str) -> bool:
    if p == "fake":
        return bool(settings.AUTH_OAUTH_FAKE)
    if p == "google":
        return bool(settings.AUTH_GOOGLE_CLIENT_ID and settings.AUTH_GOOGLE_CLIENT_SECRET)
    if p == "microsoft":
        return bool(settings.AUTH_MICROSOFT_CLIENT_ID and settings.AUTH_MICROSOFT_CLIENT_SECRET)
    if p == "apple":
        return bool(settings.AUTH_APPLE_CLIENT_ID and settings.AUTH_APPLE_TEAM_ID and settings.AUTH_APPLE_KEY_ID and settings.AUTH_APPLE_PRIVATE_KEY)
    return False


def available() -> list[str]:
    return [p for p in ("google", "apple", "microsoft", "fake") if configured(p)]


def redirect_uri(p: str) -> str:
    if p == "fake":   # the stand-in provider: same origin as the app (relative; never deployed)
        return "/api/v1/auth/oauth/fake/callback"
    base = settings.APP_URL or "http://localhost:8000"
    return f"{base}/api/v1/auth/oauth/{p}/callback"


def _client_secret(p: str) -> str:
    if p == "google":
        return settings.AUTH_GOOGLE_CLIENT_SECRET
    if p == "microsoft":
        return settings.AUTH_MICROSOFT_CLIENT_SECRET
    if p == "apple":   # a short-lived ES256 JWT signed with the team's key (Apple's documented client secret)
        now = int(time.time())
        return jwt.encode({"iss": settings.AUTH_APPLE_TEAM_ID, "iat": now, "exp": now + 300, "aud": "https://appleid.apple.com",
                           "sub": settings.AUTH_APPLE_CLIENT_ID}, settings.AUTH_APPLE_PRIVATE_KEY, algorithm="ES256",
                          headers={"kid": settings.AUTH_APPLE_KEY_ID})
    return ""


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _hash(v: str) -> str:
    return hashlib.sha256(v.encode()).hexdigest()


# ---- start --------------------------------------------------------------------------------------------------------
def begin(p: str, *, intent: str, user_id: int | None = None, client: str = "web") -> tuple[str, str]:
    """Returns (authorization URL, browser-binding value for the BIND_COOKIE)."""
    if not configured(p):
        raise OidcError("provider_not_configured")
    prov = providers()[p]
    state, nonce, bind = secrets.token_urlsafe(32), secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64) if prov.pkce else ""
    cache.set(f"oidc:state:{_hash(state)}", {"p": p, "intent": intent, "user": user_id, "nonce": nonce, "verifier": verifier,
                                              "bind": _hash(bind), "client": client, "at": int(time.time())}, STATE_TTL)
    q = {"client_id": client_id(p), "redirect_uri": redirect_uri(p), "response_type": "code", "scope": prov.scope,
         "state": state, "nonce": nonce}
    if prov.pkce:
        q.update(code_challenge=_b64(hashlib.sha256(verifier.encode()).digest()), code_challenge_method="S256")
    if prov.form_post:
        q["response_mode"] = "form_post"
    if p == "google":
        q["prompt"] = "select_account"
    if p == "microsoft":
        q["prompt"] = "select_account"
    return f"{prov.authorize}?{urlencode(q)}", bind


# ---- callback -----------------------------------------------------------------------------------------------------
def take_state(state: str, bind_cookie: str) -> dict:
    """The stored request for this state, used once, and only from the browser that started it."""
    if not state or not bind_cookie:
        raise OidcError("state_invalid")
    key = f"oidc:state:{_hash(state)}"
    data = cache.get(key)
    if not data:
        raise OidcError("state_expired")
    if not secrets.compare_digest(data["bind"], _hash(bind_cookie)):
        raise OidcError("state_invalid")    # another browser: refused, and the real one can still finish
    cache.delete(key)                       # one use: a replayed callback finds nothing
    return data


def finish(p: str, code: str, data: dict, apple_user: str = "") -> Identity:
    if data["p"] != p:
        raise OidcError("state_invalid")
    if not code:
        raise OidcError("no_code")
    id_token = _exchange(p, code, data["verifier"])
    claims = verify_id_token(p, id_token, data["nonce"])
    return _identity(p, claims, apple_user)


def _exchange(p: str, code: str, verifier: str) -> str:
    if p == "fake":
        return _fake_token_for_code(code)
    prov = providers()[p]
    form = {"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri(p), "client_id": client_id(p),
            "client_secret": _client_secret(p)}
    if verifier:
        form["code_verifier"] = verifier
    try:
        r = requests.post(prov.token, data=form, headers={"Accept": "application/json"}, timeout=10)
    except requests.RequestException:
        raise OidcError("provider_unreachable") from None
    if r.status_code != 200:
        raise OidcError("code_rejected")
    tok = (r.json() or {}).get("id_token")
    if not tok:
        raise OidcError("no_id_token")
    return tok


_jwks_clients: dict[str, jwt.PyJWKClient] = {}


def _signing_key(p: str, token: str):
    if p == "fake":
        return _fake_public_key()
    url = providers()[p].jwks
    c = _jwks_clients.get(url)
    if c is None:
        c = _jwks_clients[url] = jwt.PyJWKClient(url, cache_keys=True, lifespan=3600, timeout=10)
    try:
        return c.get_signing_key_from_jwt(token).key
    except jwt.PyJWKClientError:
        raise OidcError("token_key_unknown") from None


def verify_id_token(p: str, token: str, nonce: str) -> dict:
    try:
        key = _signing_key(p, token)
        claims = jwt.decode(token, key, algorithms=["RS256"], audience=client_id(p), leeway=LEEWAY,
                            options={"require": ["iss", "aud", "exp", "iat", "sub"]})
    except OidcError:
        raise
    except jwt.ExpiredSignatureError:
        raise OidcError("token_expired") from None
    except jwt.InvalidTokenError:
        raise OidcError("token_invalid") from None
    iss = claims.get("iss", "")
    if p == "microsoft":
        tid = str(claims.get("tid", ""))
        tenant = _tenant()
        if iss != f"https://login.microsoftonline.com/{tid}/v2.0" or (tenant not in ("common", "organizations", "consumers") and tid != tenant):
            raise OidcError("token_issuer")
    elif iss not in providers()[p].issuers:
        raise OidcError("token_issuer")
    if not nonce or not secrets.compare_digest(str(claims.get("nonce", "")), nonce):
        raise OidcError("token_nonce")
    return claims


def _truthy(v) -> bool:
    return v is True or str(v).lower() == "true"


def _identity(p: str, c: dict, apple_user: str) -> Identity:
    email = str(c.get("email") or "").strip().lower()
    name = str(c.get("name") or "").strip()
    if p == "microsoft":
        # Microsoft has no email_verified claim: personal accounts' addresses are verified by Microsoft; for work and
        # school accounts only when the tenant asserts it (xms_edov). Otherwise the address is not trusted.
        verified = bool(email) and (str(c.get("tid")) == MS_CONSUMER_TENANT or _truthy(c.get("xms_edov")))
        email = email or str(c.get("preferred_username") or "").strip().lower() if verified else email
    else:
        verified = bool(email) and _truthy(c.get("email_verified"))
    if p == "apple" and apple_user:   # the name comes only once, in the first authorization's form post (not signed)
        try:
            n = json.loads(apple_user).get("name") or {}
            name = " ".join(x for x in (n.get("firstName"), n.get("lastName")) if x).strip()[:120]
        except (ValueError, AttributeError):
            pass
    return Identity(provider=p, subject=str(c["sub"])[:255], email=email[:254], email_verified=verified, name=name[:120])


# ---- development stand-in identity provider («fake») --------------------------------------------------------------
def _fake_key():
    k = cache.get("oidc:fake:key")
    if k is None:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa

        priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        k = priv.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
        cache.set("oidc:fake:key", k, None)
    return k


def _fake_public_key():
    from cryptography.hazmat.primitives import serialization

    return serialization.load_pem_private_key(_fake_key().encode(), None).public_key()


def fake_issue_code(state: str, nonce: str, claims: dict) -> str:
    """The stand-in provider's consent: a one-time code that the token step turns into a signed ID token."""
    if not settings.AUTH_OAUTH_FAKE:
        raise OidcError("provider_not_configured")
    code = secrets.token_urlsafe(24)
    cache.set(f"oidc:fake:code:{code}", {"claims": claims, "nonce": nonce}, 120)
    return code


def _fake_token_for_code(code: str) -> str:
    d = cache.get(f"oidc:fake:code:{code}")
    cache.delete(f"oidc:fake:code:{code}")
    if not d:
        raise OidcError("code_rejected")
    now = int(time.time())
    body = {"iss": "halqa-fake-idp", "aud": "halqa-dev", "iat": now, "exp": now + 300, **d["claims"]}
    body.setdefault("nonce", d["nonce"])
    return jwt.encode(body, _fake_key(), algorithm="RS256")


def fake_sign(claims: dict) -> str:
    """Tests: an ID token signed by the stand-in provider with arbitrary claims (expired, wrong nonce…)."""
    return jwt.encode(claims, _fake_key(), algorithm="RS256")


def nonce_of(state: str) -> str | None:
    d = cache.get(f"oidc:state:{_hash(state)}")
    return d["nonce"] if d else None
