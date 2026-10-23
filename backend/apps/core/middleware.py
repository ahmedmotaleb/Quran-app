"""Attach a request id to every request/response and to every log line."""
import re
import uuid

from .logging import request_id_var

_SAFE = re.compile(r"^[A-Za-z0-9._-]{8,64}$")


class RequestIdMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        incoming = request.headers.get("X-Request-ID", "")
        rid = incoming if _SAFE.match(incoming) else uuid.uuid4().hex
        request.request_id = rid
        token = request_id_var.set(rid)
        try:
            response = self.get_response(request)
        finally:
            request_id_var.reset(token)
        response["X-Request-ID"] = rid
        return response


class HealthCheckMiddleware:
    """Answers GET/HEAD /api/health before host validation and the HTTPS redirect.

    Platform health checks (load balancers, uptime monitors) call the container directly on its internal address over
    plain HTTP, so ALLOWED_HOSTS would reject them with 400 and the deploy never goes live. This
    endpoint exposes nothing but liveness; everything else keeps the normal checks.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path == "/api/health" and request.method in ("GET", "HEAD"):
            from django.conf import settings
            from django.http import JsonResponse

            resp = JsonResponse({"status": "ok", "version": settings.APP_VERSION})
            resp["Cache-Control"] = "no-store"
            return resp
        return self.get_response(request)


def _audio_origin() -> str:
    """The approved ayah-audio hosts: Quran Foundation's CDN when it is configured, or the AYAH_AUDIO_URL host."""
    from urllib.parse import urlsplit

    from django.conf import settings

    hosts = []
    if settings.QF_CLIENT_ID and settings.QF_CLIENT_SECRET:
        hosts += list(settings.QF_AUDIO_HOSTS)
    if settings.AYAH_AUDIO_URL and (h := urlsplit(settings.AYAH_AUDIO_URL).hostname):
        hosts.append(h)
    return "".join(f" https://{h}" for h in hosts)


def build_csp() -> str:
    """Exact sources the app uses: own origin; Google Fonts; private recordings via short-lived signed links on
    Cloudflare R2 (recordings, support screenshots); and ayah audio only from the approved source. No inline scripts (Vite emits external modules only)."""
    audio = _audio_origin()
    return "; ".join([
        "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: blob: https://*.r2.cloudflarestorage.com",  # support screenshots (signed, private)
        f"media-src 'self' blob:{audio} https://*.r2.cloudflarestorage.com",
        "connect-src 'self' https://*.r2.cloudflarestorage.com",
        "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
    ])
PERMISSIONS = "microphone=(self), camera=(), geolocation=(), payment=(), usb=()"


class SecurityHeadersMiddleware:
    """Content-Security-Policy and Permissions-Policy on every response (pages, static files and API)."""

    def __init__(self, get_response):
        self.get_response = get_response
        self.csp = build_csp()

    def __call__(self, request):
        resp = self.get_response(request)
        resp.setdefault("Content-Security-Policy", self.csp)
        resp.setdefault("Permissions-Policy", PERMISSIONS)
        resp.setdefault("Cross-Origin-Opener-Policy", "same-origin")
        # Also on responses that return before Django's SecurityMiddleware (the health check).
        resp.setdefault("X-Frame-Options", "DENY")
        resp.setdefault("X-Content-Type-Options", "nosniff")
        return resp
