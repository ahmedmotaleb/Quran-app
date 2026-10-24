"""Client diagnostics for recording on real phones (owner request 24 Oct: no iPhone to test with).

When recording or sending fails on a device, nothing may reach the server (the failure happens before the upload),
so the app posts a short note here: which step, the browser's error name, which audio formats the browser supports,
whether it runs as the installed app. It is written to the server log only (read with the Ops task
`client-diagnostics`). No audio, no task text, no free text from the person: every field is checked and truncated.
"""
import logging
import re

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

log = logging.getLogger("halqa.client")

EVENTS = {"mic_denied", "recorder_unsupported", "recorder_error", "recording_empty", "recording_ok",
          "upload_failed", "submit_failed", "submit_ok"}
FAILURES = EVENTS - {"recording_ok", "submit_ok"}
_TOKEN = re.compile(r"[^A-Za-z0-9\u0600-\u06FF _:./;=,()+\-]")  # app error texts are Arabic


def _clean(v, n: int) -> str:
    return _TOKEN.sub("", str(v or ""))[:n]


def device(ua: str) -> str:
    """Browser and system family only (no full user agent)."""
    os_ = next((name for key, name in (("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"), ("Windows", "Windows"),
                                         ("Mac OS", "Mac"), ("Linux", "Linux")) if key in ua), "other")
    m = re.search(r"OS (\d+)[_.](\d+)", ua) if os_ in ("iPhone", "iPad") else re.search(r"Android (\d+)", ua)
    br = next((name for key, name in (("CriOS", "Chrome-iOS"), ("FxiOS", "Firefox-iOS"), ("SamsungBrowser", "Samsung"),
                                       ("Edg", "Edge"), ("Firefox", "Firefox"), ("Chrome/", "Chrome"), ("Safari", "Safari")) if key in ua), "other")
    return f"{br} {os_}{' ' + '.'.join(g for g in m.groups() if g) if m else ''}"


class ClientDiagnostic(APIView):
    permission_classes = [IsAuthenticated]
    throttle_scope = "diag"

    def post(self, request):
        d = request.data if isinstance(request.data, dict) else {}
        event = str(d.get("event", ""))
        if event not in EVENTS:
            return Response({"code": "invalid", "message": "unknown event"}, status=400)
        supported = d.get("supported") if isinstance(d.get("supported"), list) else []
        nums = {}
        for k in ("secs", "size_kb", "status"):
            try:
                nums[k] = round(float(d.get(k)), 1) if d.get(k) not in (None, "") else None
            except (TypeError, ValueError):
                nums[k] = None
        (log.warning if event in FAILURES else log.info)(
            "client_diagnostic",
            extra={"event": event, "step": _clean(d.get("step"), 40), "error": _clean(d.get("error"), 160),
                   "err_code": _clean(d.get("code"), 40),  # not "code": the log redacts that name "mime": _clean(d.get("mime"), 60),
                   "supported": [_clean(s, 40) for s in supported[:8]], "standalone": d.get("standalone") is True,
                   "online": d.get("online") is not False, "device": device(request.META.get("HTTP_USER_AGENT", "")),
                   "role": request.user.role, "user": request.user.pk, **nums})
        return Response(status=204)
