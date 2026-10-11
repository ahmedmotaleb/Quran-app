from django.utils import timezone
from rest_framework import exceptions
from rest_framework.authentication import BaseAuthentication, SessionAuthentication, get_authorization_header

from .models import AuthToken


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
        result = super().authenticate(request)
        if result is not None and not result[0].can_sign_in:
            raise exceptions.AuthenticationFailed()
        return result
