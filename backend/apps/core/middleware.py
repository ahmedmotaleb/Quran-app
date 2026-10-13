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
