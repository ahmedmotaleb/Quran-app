from django.utils import timezone
from rest_framework import exceptions
from rest_framework.authentication import BaseAuthentication, SessionAuthentication, get_authorization_header

from django.contrib.auth import BACKEND_SESSION_KEY, HASH_SESSION_KEY, SESSION_KEY

from .models import AuthToken, User


class BearerTokenAuthentication(BaseAuthentication):
    """`Authorization: Bearer <token>` for the Android app. Tokens are hashed, expiring and revocable."""

    keyword = b"bearer"

    def authenticate(self, request):
        parts = get_authorization_header(request).split()
        if not parts or parts[0].lower() != self.keyword:
            return None
        if len(parts) != 2:
            raise exceptions.AuthenticationFailed()
        tok = AuthToken.lookup(parts[1].decode(errors="ignore"))
        if tok is None or not tok.valid or not tok.user.can_sign_in:
            raise exceptions.AuthenticationFailed()
        now = timezone.now()
        if tok.last_used_at is None or (now - tok.last_used_at).total_seconds() > 300:
            AuthToken.objects.filter(pk=tok.pk).update(last_used_at=now)
        return tok.user, tok

    def authenticate_header(self, request):
        return "Bearer"


class CsrfSessionAuthentication(SessionAuthentication):
    """Session cookie for the web app. CSRF is always enforced; suspended users lose access immediately."""

    def authenticate(self, request):
        if is_admin_portal(request._request):
            return None  # portal requests use the portal's own session only
        result = super().authenticate(request)
        if result is not None and not result[0].can_sign_in:
            raise exceptions.AuthenticationFailed()
        return result


# ---- Admin portal: its own session -------------------------------------------------------
# The admin portal and the learners' app run on the same origin, and a phone shares one cookie jar between its
# browser tabs and installed web apps. With one session, signing in as a student in the app replaced the admin's
# session in the portal (and the other way round). The portal therefore has its own session, in its own cookie,
# used only for requests the portal marks with `X-Halqa-Portal: admin`; those requests never use the learner session.
ADMIN_COOKIE = "halqa_admin_session"
PORTAL_HEADER = "HTTP_X_HALQA_PORTAL"


def is_admin_portal(request) -> bool:
    return request.META.get(PORTAL_HEADER, "") == "admin"


def start_admin_session(request, response, user) -> None:
    """Sign the admin into the portal's own session (the learner session, if any, is left as it is)."""
    from django.conf import settings
    from django.contrib.sessions.backends.db import SessionStore
    from django.middleware.csrf import rotate_token

    s = SessionStore()
    s[SESSION_KEY], s[BACKEND_SESSION_KEY], s[HASH_SESSION_KEY] = str(user.pk), user.backend, user.get_session_auth_hash()
    s.set_expiry(settings.SESSION_COOKIE_AGE)
    s.save()
    rotate_token(request)
    from django.contrib.auth.models import update_last_login

    update_last_login(None, user)  # the portal session bypasses django.contrib.auth.login (shown in «الإدارة والصلاحيات»)
    response.set_cookie(ADMIN_COOKIE, s.session_key, max_age=settings.SESSION_COOKIE_AGE, httponly=True,
                        secure=settings.SESSION_COOKIE_SECURE, samesite="Lax", path="/")


def end_admin_session(request, response) -> None:
    from django.contrib.sessions.backends.db import SessionStore

    key = request.COOKIES.get(ADMIN_COOKIE)
    if key:
        SessionStore(session_key=key).delete()
    response.delete_cookie(ADMIN_COOKIE, path="/", samesite="Lax")


class AdminPortalSessionAuthentication(SessionAuthentication):
    """Requests from the admin portal: the portal's own session cookie, with CSRF enforced."""

    def authenticate(self, request):
        if not is_admin_portal(request._request):
            return None
        from django.contrib.sessions.backends.db import SessionStore
        from django.utils.crypto import constant_time_compare

        key = request._request.COOKIES.get(ADMIN_COOKIE)
        if not key:
            return None
        s = SessionStore(session_key=key)
        uid, h = s.get(SESSION_KEY), s.get(HASH_SESSION_KEY)
        if not uid or not h:
            return None
        user = User.objects.filter(pk=uid).first()
        # A password change (or reset) ends the session, as for Django's own sessions.
        if user is None or not constant_time_compare(h, user.get_session_auth_hash()) or not user.can_sign_in:
            return None
        from .admin_access import has_admin_access, is_teacher_admin

        if is_teacher_admin(user) and not has_admin_access(user):
            s.delete()  # admin access removed or paused: the portal session ends (the teacher app is not affected)
            return None
        self.enforce_csrf(request)
        user._admin_ctx = has_admin_access(user)  # requests made in the portal carry admin authority (acts_as_admin)
        return user, None
