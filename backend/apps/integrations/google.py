"""Minimal Google OAuth 2.0 + Calendar v3 client (requests, short timeouts).

Nothing here logs or returns a token, an authorization code or a full Meet URL. Errors carry a short code only.
`_send` is the single network call; tests replace it, and development/CI can use the in-process fake (fake.py).
"""
from __future__ import annotations

import logging
from urllib.parse import urlencode

import requests
from django.conf import settings
from django.utils import timezone

from . import crypto
from .models import GoogleCalendarConnection

log = logging.getLogger(__name__)

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
API = "https://www.googleapis.com/calendar/v3"
CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events"
# Calendar events only (no access to the rest of the calendar or the account); openid+email to show which Google
# account is connected.
SCOPES = ["openid", "email", CALENDAR_SCOPE]
TIMEOUT = (5, 20)


class GoogleError(Exception):
    """`code`: not_configured, not_connected, reconnect_required, forbidden, not_found, conflict, rate_limited,
    unavailable, bad_request, network. `retryable`: safe to try again later with the same ids."""

    def __init__(self, code: str, status: int = 0, retryable: bool = False):
        super().__init__(code)
        self.code, self.status, self.retryable = code, status, retryable


def configured() -> bool:
    return bool(settings.GOOGLE_FAKE or (settings.GOOGLE_CLIENT_ID and settings.GOOGLE_CLIENT_SECRET and settings.GOOGLE_REDIRECT_URI))


def _send(method: str, url: str, *, params=None, data=None, json=None, headers=None):
    """Returns (status, body dict). The only place that talks to Google."""
    if settings.GOOGLE_FAKE:
        from . import fake

        return fake.handle(method, url, params=params, data=data, json=json, headers=headers)
    try:
        r = requests.request(method, url, params=params, data=data, json=json, headers=headers, timeout=TIMEOUT)
    except requests.RequestException as e:
        raise GoogleError("network", retryable=True) from e
    try:
        body = r.json() if r.content else {}
    except ValueError:
        body = {}
    return r.status_code, body


def auth_url(state: str) -> str:
    if not configured():
        raise GoogleError("not_configured")
    q = {"client_id": settings.GOOGLE_CLIENT_ID or "fake", "redirect_uri": settings.GOOGLE_REDIRECT_URI or "/api/v1/integrations/google/callback",
         "response_type": "code", "scope": " ".join(SCOPES), "access_type": "offline", "include_granted_scopes": "true",
         "prompt": "consent", "state": state}
    if settings.GOOGLE_FAKE:
        return "/api/v1/integrations/google/fake-consent?" + urlencode({"state": state})
    return f"{AUTH_URL}?{urlencode(q)}"


def _email_from_id_token(id_token: str) -> str:
    """The id_token comes straight from Google's token endpoint over TLS; only its email claim is read."""
    import base64
    import json as _json

    try:
        payload = id_token.split(".")[1]
        claims = _json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return str(claims.get("email", ""))[:254] if claims.get("email_verified", True) else ""
    except (IndexError, ValueError):
        return ""


def exchange_code(code: str) -> dict:
    """Authorization code → {refresh_token, email, scopes}. Raises GoogleError."""
    status, body = _send("POST", TOKEN_URL, data={"code": code, "client_id": settings.GOOGLE_CLIENT_ID, "client_secret": settings.GOOGLE_CLIENT_SECRET,
                                                   "redirect_uri": settings.GOOGLE_REDIRECT_URI, "grant_type": "authorization_code"})
    if status != 200 or not body.get("refresh_token"):
        raise GoogleError("bad_request" if status < 500 else "unavailable", status, retryable=status >= 500)
    scopes = str(body.get("scope", ""))
    if CALENDAR_SCOPE not in scopes.split():
        raise GoogleError("scope_missing", status)
    return {"refresh_token": body["refresh_token"], "email": _email_from_id_token(str(body.get("id_token", ""))), "scopes": scopes}


def revoke(conn: GoogleCalendarConnection) -> None:
    token = crypto.decrypt(conn.encrypted_refresh_token or "") if conn.encrypted_refresh_token else None
    if token:
        try:
            _send("POST", REVOKE_URL, data={"token": token})
        except GoogleError:
            pass  # disconnecting in HALQA must not depend on Google answering


def _mark_reconnect(conn: GoogleCalendarConnection) -> None:
    GoogleCalendarConnection.objects.filter(pk=conn.pk).update(status=GoogleCalendarConnection.Status.RECONNECT, updated_at=timezone.now())
    conn.status = GoogleCalendarConnection.Status.RECONNECT
    log.warning("google_reconnect_required", extra={"teacher": conn.teacher_id})


def access_token(conn: GoogleCalendarConnection) -> str:
    """A fresh access token from the stored refresh token (not cached anywhere)."""
    if conn.status != GoogleCalendarConnection.Status.ACTIVE:
        raise GoogleError("reconnect_required" if conn.status == GoogleCalendarConnection.Status.RECONNECT else "not_connected")
    refresh = crypto.decrypt(conn.encrypted_refresh_token or "")
    if not refresh:
        _mark_reconnect(conn)
        raise GoogleError("reconnect_required")
    status, body = _send("POST", TOKEN_URL, data={"client_id": settings.GOOGLE_CLIENT_ID, "client_secret": settings.GOOGLE_CLIENT_SECRET,
                                                   "refresh_token": refresh, "grant_type": "refresh_token"})
    if status == 200 and body.get("access_token"):
        return body["access_token"]
    if status in (400, 401) and body.get("error") in ("invalid_grant", "unauthorized_client", "invalid_client"):
        _mark_reconnect(conn)  # revoked by the teacher, expired, or the app's access removed
        raise GoogleError("reconnect_required", status)
    raise GoogleError("unavailable", status, retryable=True)


def _raise_for(status: int, body: dict) -> None:
    reason = ""
    try:
        reason = (body.get("error", {}).get("errors") or [{}])[0].get("reason", "")
    except AttributeError:
        pass
    if status == 404 or status == 410:
        raise GoogleError("not_found", status)
    if status == 409:
        raise GoogleError("conflict", status)
    if status == 429 or (status == 403 and reason in ("rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded")):
        raise GoogleError("rate_limited", status, retryable=True)
    if status == 403:
        raise GoogleError("forbidden", status)
    if status >= 500:
        raise GoogleError("unavailable", status, retryable=True)
    raise GoogleError("bad_request", status)


def calendar(conn: GoogleCalendarConnection, method: str, path: str, *, params=None, json=None) -> dict:
    """One Calendar API call as the teacher. A 401 gets one fresh token and one retry."""
    for attempt in (1, 2):
        token = access_token(conn)
        status, body = _send(method, f"{API}{path}", params=params, json=json, headers={"Authorization": f"Bearer {token}"})
        if status == 401 and attempt == 1:
            continue
        if status == 401:
            _mark_reconnect(conn)
            raise GoogleError("reconnect_required", status)
        if 200 <= status < 300:
            return body or {}
        _raise_for(status, body)
    return {}


def meet_of(event: dict) -> tuple[str, str, str]:
    """(meet_url, conference_id, create_status) as returned by Google; never built by hand."""
    conf = event.get("conferenceData") or {}
    status = ((conf.get("createRequest") or {}).get("status") or {}).get("statusCode", "")
    video = next((e.get("uri", "") for e in conf.get("entryPoints") or [] if e.get("entryPointType") == "video"), "")
    url = video or event.get("hangoutLink", "")
    if url and not url.startswith("https://meet.google.com/"):
        url = ""
    return url, str(conf.get("conferenceId", "")), status or ("success" if url else "")
