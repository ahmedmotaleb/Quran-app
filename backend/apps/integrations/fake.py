"""In-process stand-in for Google OAuth + Calendar, for development and the browser tests only (GOOGLE_FAKE, refused
outside development/test in settings). Events live in the cache. Meet links look like Google's but come from here,
exactly as the real code reads them (the response's conferenceData), so the same code path is exercised."""
import base64
import hashlib
import json as _json

from django.core.cache import cache

KEY = "google-fake:events"


def _events() -> dict:
    return cache.get(KEY) or {}


def _save(ev: dict) -> None:
    cache.set(KEY, ev, 24 * 3600)


def _meet(request_id: str) -> dict:
    h = hashlib.sha256(request_id.encode()).hexdigest()
    code = f"{h[:3]}-{h[3:7]}-{h[7:10]}"
    url = f"https://meet.google.com/{code}"
    return {"conferenceId": code, "entryPoints": [{"entryPointType": "video", "uri": url}],
            "createRequest": {"requestId": request_id, "status": {"statusCode": "success"}}}


def handle(method, url, *, params=None, data=None, json=None, headers=None):
    if url.endswith("/token"):
        if (data or {}).get("grant_type") == "authorization_code":
            claims = base64.urlsafe_b64encode(_json.dumps({"email": "teacher.calendar@example.com", "email_verified": True}).encode()).decode().rstrip("=")
            return 200, {"refresh_token": "fake-refresh", "access_token": "fake-access", "id_token": f"x.{claims}.y",
                         "scope": "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events"}
        return 200, {"access_token": "fake-access", "expires_in": 3600}
    if url.endswith("/revoke"):
        return 200, {}
    events = _events()
    path = url.split("/calendar/v3", 1)[-1]
    parts = path.strip("/").split("/")  # calendars/<cal>/events[/<id>]
    eid = parts[3] if len(parts) > 3 else None
    if method == "POST":
        body = dict(json or {})
        if body.get("id") in events:
            return 409, {"error": {"code": 409, "errors": [{"reason": "duplicate"}]}}
        req = ((body.get("conferenceData") or {}).get("createRequest") or {}).get("requestId", "")
        body["conferenceData"] = _meet(req) if req else {}
        body["htmlLink"] = f"https://www.google.com/calendar/event?eid={body['id']}"
        body["status"] = "confirmed"
        events[body["id"]] = body
        _save(events)
        return 200, body
    if eid not in events:
        return 404, {"error": {"code": 404, "errors": [{"reason": "notFound"}]}}
    if method == "GET":
        return 200, events[eid]
    if method == "PATCH":
        events[eid].update({k: v for k, v in (json or {}).items() if k != "conferenceData"})
        _save(events)
        return 200, events[eid]
    if method == "DELETE":
        events.pop(eid)
        _save(events)
        return 204, {}
    return 400, {}
