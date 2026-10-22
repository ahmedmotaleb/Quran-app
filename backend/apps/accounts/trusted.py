"""Trusted devices for admin two-step verification (owner request, 22 October 2026: "authentication not every time").

After a correct authenticator code, the admin may tick «تذكّر هذا الجهاز». That browser then gets an HttpOnly cookie
and, for TRUST_DAYS, signs in with the password only. The password is always required; the trust ends when it expires,
when the admin removes the device (or all devices), when the password or the authenticator changes, or when two-step
verification is reset. Using a trusted device is audited (`auth.mfa_trusted_device`).
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import timedelta

from django.conf import settings
from django.utils import timezone
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.audit import audit
from apps.core.exceptions import ApiError

from .models import TrustedDevice
from .permissions import IsAdminRole

COOKIE = "halqa_admin_trusted"
TRUST_DAYS = 30


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def marker(user) -> str:
    return _sha(f"{user.get_session_auth_hash()}:{user.mfa_secret}")


def _label(request) -> str:
    ua = request.META.get("HTTP_USER_AGENT", "")
    browser = next((n for k, n in (("Edg/", "Edge"), ("SamsungBrowser", "Samsung Internet"), ("Firefox", "Firefox"),
                                   ("CriOS", "Chrome"), ("Chrome", "Chrome"), ("Safari", "Safari")) if k in ua), "متصفح")
    system = next((n for k, n in (("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"), ("Windows", "Windows"),
                                  ("Mac OS", "Mac"), ("Linux", "Linux")) if k in ua), "")
    return f"{browser} — {system}" if system else browser


def trusted(request, user) -> TrustedDevice | None:
    raw = request.COOKIES.get(COOKIE)
    if not raw or not user.mfa_enabled:
        return None
    d = TrustedDevice.objects.filter(token_hash=_sha(raw), user=user, revoked_at__isnull=True,
                                     expires_at__gt=timezone.now()).first()
    if d is None or not secrets.compare_digest(d.marker, marker(user)):
        return None
    return d


def use(request, d: TrustedDevice) -> None:
    d.last_used_at = timezone.now()
    d.save(update_fields=["last_used_at"])
    audit("auth.mfa_trusted_device", actor=d.user, target=d.user, request=request, device=d.pk)


def remember(request, response, user) -> None:
    raw = secrets.token_urlsafe(32)
    d = TrustedDevice.objects.create(user=user, token_hash=_sha(raw), marker=marker(user), label=_label(request),
                                     expires_at=timezone.now() + timedelta(days=TRUST_DAYS))
    response.set_cookie(COOKIE, raw, max_age=TRUST_DAYS * 86400, httponly=True, secure=settings.SESSION_COOKIE_SECURE,
                        samesite="Lax", path="/")
    audit("auth.device_trusted", actor=user, target=user, request=request, device=d.pk, days=TRUST_DAYS)


def _out(d: TrustedDevice, current: TrustedDevice | None) -> dict:
    return {"id": d.pk, "label": d.label or "متصفح", "created_at": d.created_at.isoformat(), "expires_at": d.expires_at.isoformat(),
            "last_used_at": d.last_used_at.isoformat() if d.last_used_at else None, "current": bool(current and current.pk == d.pk)}


class TrustedDeviceList(APIView):
    """GET: the signed-in admin's trusted devices. DELETE: remove them all (the code is asked again everywhere)."""

    permission_classes = [IsAdminRole]

    def get(self, request):
        cur = trusted(request, request.user)
        qs = TrustedDevice.objects.filter(user=request.user, revoked_at__isnull=True, expires_at__gt=timezone.now()).order_by("-created_at")
        return Response({"results": [_out(d, cur) for d in qs if secrets.compare_digest(d.marker, marker(request.user))],
                         "days": TRUST_DAYS})

    def delete(self, request):
        n = TrustedDevice.objects.filter(user=request.user, revoked_at__isnull=True).update(revoked_at=timezone.now())
        audit("auth.devices_untrusted", actor=request.user, target=request.user, request=request, count=n)
        resp = Response({"removed": n})
        resp.delete_cookie(COOKIE, path="/", samesite="Lax")
        return resp


class TrustedDeviceRevoke(APIView):
    permission_classes = [IsAdminRole]

    def post(self, request, pk):
        d = TrustedDevice.objects.filter(pk=pk, user=request.user, revoked_at__isnull=True).first()
        if d is None:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        d.revoked_at = timezone.now()
        d.save(update_fields=["revoked_at"])
        audit("auth.devices_untrusted", actor=request.user, target=request.user, request=request, count=1, device=d.pk)
        return Response({"removed": 1})
