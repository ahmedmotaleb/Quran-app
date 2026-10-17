"""Ayah recitation audio from the Quran Foundation Content API (Quran.com), the owner-approved licensed source.

- OAuth2 client credentials (`scope=content`); the token is cached until shortly before it expires and requested
  again once after a 401. The client secret stays on the server.
- One request set per surah (`/recitations/{id}/by_chapter/{surah}`, 50 per page). The URL list is cached for one
  day (the terms allow at most one week). The audio files themselves are never copied: browsers stream them from
  Quran Foundation's CDN, which is the only audio host the Content-Security-Policy allows.
- Only https URLs on the known QF audio hosts are passed on; anything else is dropped.
"""
from __future__ import annotations

import base64
import json
import logging
import urllib.error
import urllib.parse
import urllib.request

from django.conf import settings
from django.core.cache import cache

log = logging.getLogger(__name__)

HOSTS = {
    "prelive": ("https://prelive-oauth2.quran.foundation", "https://apis-prelive.quran.foundation"),
    "production": ("https://oauth2.quran.foundation", "https://apis.quran.foundation"),
}
CDN = "https://verses.quran.foundation/"
URLS_TTL = 24 * 3600


class AudioUnavailable(Exception):
    pass


def configured() -> bool:
    return bool(settings.QF_CLIENT_ID and settings.QF_CLIENT_SECRET)


def _http(req: urllib.request.Request) -> dict:
    with urllib.request.urlopen(req, timeout=10) as r:  # noqa: S310 (fixed https hosts above)
        return json.loads(r.read().decode())


def _token(force: bool = False) -> str:
    key = f"qf:token:{settings.QF_ENV}:{settings.QF_CLIENT_ID}"
    if not force and (t := cache.get(key)):
        return t
    oauth, _ = HOSTS[settings.QF_ENV]
    basic = base64.b64encode(f"{settings.QF_CLIENT_ID}:{settings.QF_CLIENT_SECRET}".encode()).decode()
    req = urllib.request.Request(f"{oauth}/oauth2/token", data=b"grant_type=client_credentials&scope=content", method="POST",
                                 headers={"Authorization": f"Basic {basic}", "Content-Type": "application/x-www-form-urlencoded"})
    try:
        d = _http(req)
    except (urllib.error.URLError, ValueError, TimeoutError) as e:
        log.error("qf_token_failed", extra={"error": type(e).__name__})
        raise AudioUnavailable from None
    t = d.get("access_token")
    if not t:
        raise AudioUnavailable
    cache.set(key, t, max(60, int(d.get("expires_in", 3600)) - 120))
    return t


def _get(path: str, query: dict) -> dict:
    _, api = HOSTS[settings.QF_ENV]
    url = f"{api}/content/api/v4{path}?{urllib.parse.urlencode(query)}"
    for attempt in (0, 1):
        req = urllib.request.Request(url, headers={"x-auth-token": _token(force=attempt == 1), "x-client-id": settings.QF_CLIENT_ID,
                                                   "Accept": "application/json"})
        try:
            return _http(req)
        except urllib.error.HTTPError as e:
            if e.code == 401 and attempt == 0:
                continue  # token expired early: request a new one, once
            log.error("qf_request_failed", extra={"status": e.code})
            raise AudioUnavailable from None
        except (urllib.error.URLError, ValueError, TimeoutError) as e:
            log.error("qf_request_failed", extra={"error": type(e).__name__})
            raise AudioUnavailable from None
    raise AudioUnavailable


def _absolute(u: str) -> str | None:
    full = urllib.parse.urljoin(CDN, u.lstrip("/")) if not u.startswith(("http://", "https://", "//")) else ("https:" + u if u.startswith("//") else u)
    p = urllib.parse.urlsplit(full)
    return full if p.scheme == "https" and p.hostname in settings.QF_AUDIO_HOSTS else None


def surah_audio(surah: int) -> dict[int, str]:
    """{ayah number: https URL} for one surah, from the configured recitation. Empty if QF has none for it."""
    if not configured():
        raise AudioUnavailable
    key = f"qf:audio:{settings.QF_ENV}:{settings.QF_RECITATION_ID}:{surah}"
    if (hit := cache.get(key)) is not None:
        return {int(k): v for k, v in hit.items()}
    out: dict[int, str] = {}
    page = 1
    while page and page <= 10:  # the longest surah (286 ayahs) is 6 pages of 50
        d = _get(f"/recitations/{settings.QF_RECITATION_ID}/by_chapter/{surah}", {"per_page": 50, "page": page})
        for f in d.get("audio_files", []):
            vk, u = str(f.get("verse_key", "")), f.get("url") or ""
            s, _, a = vk.partition(":")
            if s == str(surah) and a.isdigit() and (absu := _absolute(u)):
                out[int(a)] = absu
        page = (d.get("pagination") or {}).get("next_page")
    cache.set(key, {str(k): v for k, v in out.items()}, URLS_TTL)
    return out
