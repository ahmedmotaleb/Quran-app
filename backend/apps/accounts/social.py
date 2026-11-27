"""Sign-in with Google, Apple and Microsoft, and «طرق تسجيل الدخول» (owner request, 27 Nov 2026). Rules:

Signing in (`intent=login`), after oidc.finish() verified the provider's ID token:
1. The provider account is already connected (AuthIdentity provider+sub) → that HALQA account. Never another one.
2. Not connected, but a HALQA account has the same email → NOT merged automatically. If the provider verified the
   email, a one-time confirmation link is emailed to the HALQA account's address; opening it connects and signs in
   (proof of the mailbox). Otherwise the person signs in with their password and connects from «طرق تسجيل الدخول».
3. No account → a new one, only with a provider-verified email: the person chooses طالب / معلم / ولي أمر and completes
   their name; the server creates the account. Students when public sign-up is open; a teacher starts unapproved and
   follows the existing approval; a parent sees only children an admin links. Never an admin; the role choice is
   checked on the server and grants nothing more.
Admin accounts never sign in this way (the admin portal keeps its password + two-step code).

The callback never signs in by itself: it hands the app a one-time ticket (in the URL fragment, never sent to a
server) that only the same browser can redeem (the binding cookie), so Apple's cross-site form post, the PWA and the
Android app all end in the app's normal session (web cookie or native token).

Connecting (`intent=link`) is started by the signed-in user; the provider account must not belong to anyone else.
Disconnecting is refused for the last way in (no password and no other provider).
Every step is audited (`auth.oauth_*`), without tokens or claims.
"""
from __future__ import annotations

import logging
import secrets
from datetime import timedelta
from urllib.parse import quote

from django.conf import settings
from django.contrib.auth import password_validation
from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.shortcuts import redirect
from django.utils import timezone
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.audit import audit
from apps.core.exceptions import ApiError
from apps.core.models import AppSettings

from . import oidc
from .models import AccountStatus, AuthIdentity, AuthToken, LoginSession, Role, StudentProfile, TeacherProfile, User

log = logging.getLogger(__name__)
TICKET_TTL = 300
SIGNUP_TTL = 1800
LINK_TTL = 1800
RECENT_LOGIN = timedelta(minutes=15)       # «تعيين كلمة مرور» without the current one needs a fresh sign-in
LABEL = {"google": "Google", "apple": "Apple", "microsoft": "Microsoft", "fake": "Development"}


def _mask(email: str) -> str:
    if "@" not in email:
        return ""
    name, dom = email.split("@", 1)
    return f"{name[:2]}{'•' * max(2, len(name) - 2)}@{dom}"


def _app_url(fragment: str, provider: str = "") -> str:
    # The development stand-in provider runs on whatever origin the app is served from (e2e): a relative URL.
    return f"{'' if provider == 'fake' else settings.FRONTEND_URL}/#/oauth?{fragment}"


def _bind_cookie(resp, value: str, request) -> None:
    secure = request.is_secure() or settings.SESSION_COOKIE_SECURE
    # Apple answers with a cross-site form POST: the binding cookie must travel with it (SameSite=None needs Secure).
    resp.set_cookie(oidc.BIND_COOKIE, value, max_age=oidc.STATE_TTL + TICKET_TTL, httponly=True, secure=secure,
                    samesite="None" if secure else "Lax", path="/api/v1/auth/oauth")


def _ticket(kind: str, data: dict, ttl: int) -> str:
    t = secrets.token_urlsafe(32)
    cache.set(f"oidc:{kind}:{oidc._hash(t)}", data, ttl)
    return t


def _redeem(kind: str, t: str, bind: str | None = None) -> dict:
    key = f"oidc:{kind}:{oidc._hash(t or '')}"
    d = cache.get(key)
    cache.delete(key)
    if not d or (bind is not None and not secrets.compare_digest(d.get("bind", ""), oidc._hash(bind or ""))):
        raise ApiError("oauth_expired", "انتهت صلاحية طلب الدخول. ابدأ من جديد.", 400)
    return d


def device_label(request) -> str:
    ua = (request.META.get("HTTP_USER_AGENT") or "")[:400]
    os_ = next((n for k, n in (("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"), ("Windows", "Windows"),
                                ("Mac OS", "Mac"), ("Linux", "Linux")) if k in ua), "")
    br = next((n for k, n in (("SamsungBrowser", "Samsung Internet"), ("EdgA", "Edge"), ("Edg/", "Edge"), ("OPR", "Opera"),
                                ("Firefox", "Firefox"), ("CriOS", "Chrome"), ("Chrome", "Chrome"), ("Safari", "Safari")) if k in ua), "")
    return " · ".join(x for x in (br, os_) if x) or "متصفح"


def record_session(request, user, *, method: str, token: AuthToken | None = None) -> LoginSession:
    key = "" if token else (request.session.session_key or "")
    return LoginSession.objects.create(user=user, session_key=key, token=token, method=method, device=device_label(request))


def sign_in(request, user, *, client: str, device: str, method: str) -> dict:
    """The app's normal session (web cookie, or a native token shown once) plus its «الأجهزة المسجّلة» row."""
    from django.contrib.auth import login

    from .serializers import MeSerializer

    data = {"user": MeSerializer(user).data}
    if client == "native":
        tok, raw = AuthToken.issue(user, device=device)
        data["token"] = raw
        record_session(request, user, method=method, token=tok)
    else:
        user.backend = "django.contrib.auth.backends.ModelBackend"
        login(request, user)
        record_session(request, user, method=method)
    return data


def _check_can_sign_in(user: User) -> None:
    if user.role == Role.ADMIN:
        raise ApiError("admin_portal_only", "حساب الإدارة يدخل من بوابة الإدارة بكلمة المرور ورمز التحقق.", 403)
    if user.status in (AccountStatus.SUSPENDED, AccountStatus.ARCHIVED):
        raise ApiError("account_suspended", "تم إيقاف هذا الحساب. تواصل مع إدارة الحلقة.", 403)
    if not user.can_sign_in:
        raise ApiError("account_pending", "حسابك بانتظار اعتماد الإدارة.", 403)


def _identity_dict(i: oidc.Identity) -> dict:
    return {"provider": i.provider, "subject": i.subject, "email": i.email, "email_verified": i.email_verified, "name": i.name}


def link_identity(user: User, i: dict) -> AuthIdentity:
    """Connect a verified provider account to `user`. Refused if it belongs to another account or the user already
    has a different account of this provider."""
    other = AuthIdentity.objects.filter(provider=i["provider"], subject=i["subject"]).first()
    if other is not None:
        if other.user_id == user.pk:
            return other
        raise ApiError("identity_in_use", f"حساب {LABEL[i['provider']]} هذا مرتبط بحساب آخر في الحلقة.", 409)
    if AuthIdentity.objects.filter(user=user, provider=i["provider"]).exists():
        raise ApiError("provider_already_linked", f"لديك حساب {LABEL[i['provider']]} مرتبط بالفعل. افصله أولًا لربط حساب آخر.", 409)
    try:
        with transaction.atomic():
            return AuthIdentity.objects.create(user=user, provider=i["provider"], subject=i["subject"], email=i["email"],
                                               email_verified=i["email_verified"])
    except IntegrityError:
        raise ApiError("identity_in_use", f"حساب {LABEL[i['provider']]} هذا مرتبط بحساب آخر في الحلقة.", 409) from None


# ---- start / callback -----------------------------------------------------------------------------------------------
class OAuthProviders(APIView):
    """The sign-in buttons the app should show: only providers whose credentials are configured on the server."""

    authentication_classes: list = []
    permission_classes = [AllowAny]

    def get(self, request):
        return Response({"providers": [{"id": p, "label": LABEL[p]} for p in oidc.available()]})


class OAuthStart(APIView):
    """POST {intent: login|link, client: web|native} → {auth_url}. `link` needs the signed-in user."""

    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def post(self, request, provider):
        intent = str(request.data.get("intent") or "login")
        if intent not in ("login", "link") or provider not in oidc.providers():
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400)
        user_id = None
        if intent == "link":
            if not request.user.is_authenticated:
                raise ApiError("not_authenticated", "سجّل الدخول أولًا.", 401)
            user_id = request.user.pk
        try:
            url, bind = oidc.begin(provider, intent=intent, user_id=user_id, client=str(request.data.get("client") or "web"))
        except oidc.OidcError:
            raise ApiError("provider_not_configured", f"الدخول باستخدام {LABEL.get(provider, provider)} غير متاح حاليًا.", 404) from None
        audit("auth.oauth_start", actor=request.user if user_id else None, request=request, provider=provider, intent=intent)
        resp = Response({"auth_url": url})
        _bind_cookie(resp, bind, request)
        return resp


class OAuthCallback(APIView):
    """The provider sends the browser back here (GET; Apple: a form POST). Ends with a redirect into the app."""

    authentication_classes: list = []
    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def get(self, request, provider):
        return self._handle(request, provider, request.query_params)

    def post(self, request, provider):
        return self._handle(request, provider, request.data)

    def _handle(self, request, provider, q):
        if q.get("error"):
            return redirect(_app_url("result=cancelled", provider))
        bind = request.COOKIES.get(oidc.BIND_COOKIE, "")
        try:
            data = oidc.take_state(str(q.get("state") or ""), bind)
            ident = oidc.finish(provider, str(q.get("code") or ""), data, apple_user=str(q.get("user") or ""))
        except oidc.OidcError as e:
            audit("auth.oauth_failed", request=request, provider=provider, reason=e.code)
            log.warning("oauth_failed", extra={"provider": provider, "reason": e.code})
            return redirect(_app_url(f"result=failed&reason={e.code}", provider))
        i = _identity_dict(ident)
        if data["intent"] == "link":
            user = User.objects.filter(pk=data["user"]).first()
            if user is None:
                return redirect(_app_url("result=failed&reason=state_invalid", provider))
            try:
                link_identity(user, i)
            except ApiError as e:
                audit("auth.oauth_link_refused", actor=user, target=user, request=request, provider=provider, reason=e.code)
                return redirect(_app_url(f"result={e.code}&provider={provider}", provider))
            audit("auth.oauth_linked", actor=user, target=user, request=request, provider=provider)
            return redirect(_app_url(f"result=linked&provider={provider}", provider))
        return redirect(_app_url(self._login(request, provider, i, bind, data.get("client", "web")), provider))

    def _login(self, request, provider, i: dict, bind: str, client: str) -> str:
        known = AuthIdentity.objects.select_related("user").filter(provider=provider, subject=i["subject"]).first()
        if known is not None:
            t = _ticket("login", {"user": known.user_id, "identity": known.pk, "bind": oidc._hash(bind), "method": provider}, TICKET_TTL)
            return f"ticket={t}"
        same = User.objects.filter(email__iexact=i["email"]).first() if i["email"] else None
        if same is not None:
            # Never merged on an email match. A verified provider email may be confirmed through the HALQA mailbox.
            if i["email_verified"] and same.role != Role.ADMIN and same.status == AccountStatus.ACTIVE:
                from .emails import send_link_email

                t = _ticket("confirm", {"user": same.pk, "identity": i}, LINK_TTL)
                sent = send_link_email(same.email, subject="الحلقة: تأكيد ربط تسجيل الدخول",
                                       intro=f"طُلب ربط حساب {LABEL[provider]} ({i['email']}) بحسابك في الحلقة لتسجيل الدخول به. "
                                             "إن كنت أنت، اضغط الزر لتأكيد الربط.",
                                       cta="تأكيد الربط وتسجيل الدخول", link=_app_url(f"confirm={t}"),
                                       expires_at=timezone.now() + timedelta(seconds=LINK_TTL))
                audit("auth.oauth_link_email", target=same, request=request, provider=provider, sent=sent)
                return f"result={'link_email_sent' if sent else 'link_required'}&provider={provider}&email={quote(_mask(same.email))}"
            audit("auth.oauth_link_required", target=same, request=request, provider=provider)
            return f"result=link_required&provider={provider}&email={quote(_mask(same.email))}"
        if not i["email"] or not i["email_verified"]:
            audit("auth.oauth_unverified_email", request=request, provider=provider)
            return f"result=email_unverified&provider={provider}"
        if not AppSettings.load().open_signup:
            return "result=signup_closed"
        t = _ticket("signup", {"identity": i, "bind": oidc._hash(bind), "client": client}, SIGNUP_TTL)
        return f"signup={t}&provider={provider}&name={quote(i['name'])}&email={quote(_mask(i['email']))}"


class OAuthFinish(APIView):
    """POST {ticket, client, device}: the app redeems the callback's one-time ticket (same browser) for its session."""

    authentication_classes: list = []
    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def post(self, request):
        d = _redeem("login", str(request.data.get("ticket") or ""), request.COOKIES.get(oidc.BIND_COOKIE, ""))
        user = User.objects.filter(pk=d["user"]).first()
        if user is None:
            raise ApiError("oauth_expired", "انتهت صلاحية طلب الدخول. ابدأ من جديد.", 400)
        _check_can_sign_in(user)
        AuthIdentity.objects.filter(pk=d["identity"]).update(last_login_at=timezone.now())
        audit("auth.login", actor=user, target=user, request=request, client=str(request.data.get("client") or "web"), via=d["method"],
              portal="learning")
        resp = Response(sign_in(request, user, client=str(request.data.get("client") or "web"), device=str(request.data.get("device") or ""),
                                method=d["method"]))
        resp.delete_cookie(oidc.BIND_COOKIE, path="/api/v1/auth/oauth")
        return resp


class OAuthSignup(APIView):
    """POST {ticket, role: student|teacher|parent, full_name, gender, timezone, client}: a new account from a verified
    provider identity. The server decides what each role may do; admins are never created here."""

    authentication_classes: list = []
    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def post(self, request):
        from .display import strip_title

        role = str(request.data.get("role") or "")
        if role not in (Role.STUDENT, Role.TEACHER, Role.PARENT):
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"role": ["اختر: طالب أو معلم أو ولي أمر."]})
        name = strip_title(str(request.data.get("full_name") or "").strip())[:120]
        if len(name) < 2:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"full_name": ["أدخل اسمك الكامل."]})
        gender = str(request.data.get("gender") or "")
        if gender not in ("male", "female"):
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"gender": ["اختر: ذكر أو أنثى."]})
        tz = str(request.data.get("timezone") or "Africa/Cairo")
        try:
            from zoneinfo import ZoneInfo

            ZoneInfo(tz)
        except Exception:  # noqa: BLE001
            tz = "Africa/Cairo"
        if not AppSettings.load().open_signup:
            raise ApiError("signup_closed", "التسجيل العام مغلق حاليًا. تواصل مع إدارة الحلقة.", 403)
        d = _redeem("signup", str(request.data.get("ticket") or ""), request.COOKIES.get(oidc.BIND_COOKIE, ""))
        i = d["identity"]
        try:
            with transaction.atomic():
                if User.objects.filter(email__iexact=i["email"]).exists():
                    raise ApiError("email_taken", "لهذا البريد حساب بالفعل. سجّل الدخول به ثم اربط من «طرق تسجيل الدخول».", 409)
                user = User.objects.create_user(i["email"], None, full_name=name, role=role, timezone=tz, gender=gender)  # no password
                if role == Role.STUDENT:
                    StudentProfile.objects.create(user=user)
                elif role == Role.TEACHER:
                    TeacherProfile.objects.create(user=user)   # approved_at empty: the existing approval decides
                link_identity(user, i)
                audit("user.registered", actor=user, target=user, request=request, via=i["provider"], role=role)
        except IntegrityError:
            raise ApiError("email_taken", "لهذا البريد حساب بالفعل. سجّل الدخول به ثم اربط من «طرق تسجيل الدخول».", 409) from None
        if role == Role.TEACHER:
            try:
                from .teacher_onboarding import notify_admins_teacher_ready

                transaction.on_commit(lambda: notify_admins_teacher_ready(user))
            except Exception:  # noqa: BLE001 — the account exists; the admins also see it in «المعلمون»
                log.exception("teacher_signup_notify_failed")
        _check_can_sign_in(user)
        resp = Response(sign_in(request, user, client=str(request.data.get("client") or d.get("client") or "web"),
                                device=str(request.data.get("device") or ""), method=i["provider"]), status=201)
        resp.delete_cookie(oidc.BIND_COOKIE, path="/api/v1/auth/oauth")
        return resp


class OAuthConfirmLink(APIView):
    """POST {token, client}: the emailed confirmation (proof of the HALQA mailbox) connects the provider account to the
    existing HALQA account and signs in."""

    authentication_classes: list = []
    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def post(self, request):
        d = _redeem("confirm", str(request.data.get("token") or ""))
        user = User.objects.filter(pk=d["user"]).first()
        if user is None:
            raise ApiError("oauth_expired", "انتهت صلاحية الرابط. ابدأ من جديد.", 400)
        _check_can_sign_in(user)
        with transaction.atomic():
            ident = link_identity(user, d["identity"])
            ident.last_login_at = timezone.now()
            ident.save(update_fields=["last_login_at"])
        audit("auth.oauth_linked", actor=user, target=user, request=request, provider=ident.provider, via="email_confirmation")
        audit("auth.login", actor=user, target=user, request=request, via=ident.provider, portal="learning")
        return Response(sign_in(request, user, client=str(request.data.get("client") or "web"), device=str(request.data.get("device") or ""),
                                method=ident.provider))


# ---- «طرق تسجيل الدخول» ---------------------------------------------------------------------------------------------
def methods_out(user: User) -> dict:
    ids = {i.provider: i for i in AuthIdentity.objects.filter(user=user)}
    return {
        "has_password": user.has_usable_password(),
        "providers": [{"id": p, "label": LABEL[p], "available": oidc.configured(p), "connected": p in ids,
                       "email": _mask(ids[p].email) if p in ids and ids[p].email else "",
                       "connected_at": ids[p].created_at.isoformat() if p in ids else None,
                       "last_login_at": ids[p].last_login_at.isoformat() if p in ids and ids[p].last_login_at else None}
                      for p in ("google", "apple", "microsoft", "fake") if p != "fake" or oidc.configured("fake") or p in ids],
    }


def _ways_in(user: User) -> int:
    return int(user.has_usable_password()) + AuthIdentity.objects.filter(user=user).count()


class MyAuthMethods(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(methods_out(request.user))


class MyAuthMethodDetail(APIView):
    """DELETE: disconnect a provider, unless it is the last way into the account."""

    permission_classes = [IsAuthenticated]

    def delete(self, request, provider):
        with transaction.atomic():
            user = User.objects.select_for_update().get(pk=request.user.pk)
            ident = AuthIdentity.objects.filter(user=user, provider=provider).first()
            if ident is None:
                raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
            if _ways_in(user) <= 1:
                raise ApiError("last_method", "لا يمكن فصل آخر طريقة لتسجيل الدخول. عيّن كلمة مرور أو اربط حسابًا آخر أولًا.", 409)
            ident.delete()
        audit("auth.oauth_unlinked", actor=request.user, target=request.user, request=request, provider=provider)
        return Response(methods_out(request.user))


class SetPasswordView(APIView):
    """POST {password}: a password for an account that signs in only with a provider. Needs a sign-in in the last
    15 minutes (a borrowed open session cannot add a password). Changing an existing password stays
    auth/password/change (current password required)."""

    permission_classes = [IsAuthenticated]
    throttle_scope = "auth"

    def post(self, request):
        user = request.user
        if user.has_usable_password():
            raise ApiError("has_password", "لديك كلمة مرور بالفعل. استخدم «تغيير كلمة المرور».", 409)
        cur = current_session(request)
        if cur is None or timezone.now() - cur.created_at > RECENT_LOGIN:
            raise ApiError("reauth_required", "لأمان حسابك، سجّل الخروج ثم الدخول من جديد، ثم عيّن كلمة المرور خلال 15 دقيقة.", 403)
        pw = str(request.data.get("password") or "")
        try:
            password_validation.validate_password(pw, user)
        except Exception as e:  # noqa: BLE001 — django ValidationError
            from .serializers import arabic_password_error

            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"password": [arabic_password_error(e)]}) from None
        user.set_password(pw)
        user.save(update_fields=["password"])
        if not isinstance(request.auth, AuthToken):   # keep this browser signed in (the session hash changes)
            from django.contrib.auth import update_session_auth_hash

            update_session_auth_hash(request, user)
            cur.session_key = request.session.session_key or cur.session_key
            cur.save(update_fields=["session_key"])
        audit("auth.password_set", actor=user, target=user, request=request)
        return Response(methods_out(user))


# ---- «الأجهزة المسجّلة» ---------------------------------------------------------------------------------------------
def current_session(request) -> LoginSession | None:
    if isinstance(request.auth, AuthToken):
        return LoginSession.objects.filter(token=request.auth, ended_at__isnull=True).first()
    key = request.session.session_key if hasattr(request, "session") else None
    return LoginSession.objects.filter(user=request.user, session_key=key, ended_at__isnull=True).order_by("-created_at").first() if key else None


def _alive(s: LoginSession, now) -> bool:
    if s.token_id:
        return s.token is not None and s.token.valid
    return Session.objects.filter(session_key=s.session_key, expire_date__gt=now).exists()


def end_session(s: LoginSession, now=None) -> None:
    now = now or timezone.now()
    if s.token_id:
        AuthToken.objects.filter(pk=s.token_id, revoked_at__isnull=True).update(revoked_at=now)
    elif s.session_key:
        Session.objects.filter(session_key=s.session_key).delete()
    # That device's phone notifications stop with its session: never delivered to a signed-out account.
    from apps.notifications.models import PushSubscription

    PushSubscription.objects.filter(login_session=s).delete()
    s.ended_at = now
    s.save(update_fields=["ended_at"])


def sessions_out(request) -> dict:
    now = timezone.now()
    cur = current_session(request)
    rows = []
    for s in LoginSession.objects.filter(user=request.user, ended_at__isnull=True).select_related("token").order_by("-created_at")[:50]:
        if not _alive(s, now):
            s.ended_at = now
            s.save(update_fields=["ended_at"])
            continue
        rows.append({"id": s.pk, "device": s.device, "method": s.method, "method_label": LABEL.get(s.method, "كلمة المرور"),
                     "app": "التطبيق" if s.token_id else "المتصفح", "created_at": s.created_at.isoformat(), "current": cur is not None and s.pk == cur.pk})
    return {"results": rows}


class MySessions(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(sessions_out(request))


class MySessionEnd(APIView):
    permission_classes = [IsAuthenticated]

    def delete(self, request, pk):
        s = LoginSession.objects.filter(pk=pk, user=request.user, ended_at__isnull=True).select_related("token").first()
        if s is None:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        cur = current_session(request)
        if cur is not None and cur.pk == s.pk:
            raise ApiError("current_session", "هذا الجهاز الحالي. استخدم «تسجيل الخروج».", 409)
        end_session(s)
        audit("auth.session_ended", actor=request.user, target=request.user, request=request, session=s.pk)
        return Response(sessions_out(request))


class MySessionsEndOthers(APIView):
    """POST «تسجيل الخروج من الأجهزة الأخرى»: every session but this one ends (web sessions deleted, app tokens revoked)."""

    permission_classes = [IsAuthenticated]

    def post(self, request):
        cur = current_session(request)
        now, n = timezone.now(), 0
        for s in LoginSession.objects.filter(user=request.user, ended_at__isnull=True).select_related("token"):
            if cur is not None and s.pk == cur.pk:
                continue
            end_session(s, now)
            n += 1
        # Sessions from before this list existed: other app tokens are revoked too.
        AuthToken.objects.filter(user=request.user, revoked_at__isnull=True).exclude(
            pk=request.auth.pk if isinstance(request.auth, AuthToken) else None).update(revoked_at=now)
        audit("auth.sessions_ended_others", actor=request.user, target=request.user, request=request, count=n)
        return Response({**sessions_out(request), "ended": n})


# ---- development stand-in provider page -----------------------------------------------------------------------------
class FakeAuthorize(APIView):
    """AUTH_OAUTH_FAKE only (never deployed): a consent page that returns to our callback with a code, so e2e tests run
    the real callback and ID-token verification. GET shows the form; POST (or GET with `sub`) answers."""

    authentication_classes: list = []
    permission_classes = [AllowAny]

    def get(self, request):
        if not settings.AUTH_OAUTH_FAKE:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        q = request.query_params
        if q.get("sub"):
            return self._answer(q)
        from django.http import HttpResponse
        from django.utils.html import escape

        hidden = "".join(f'<input type="hidden" name="{escape(k)}" value="{escape(v)}">' for k, v in q.items())
        return HttpResponse(f"""<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>Development sign-in</title>
<body style="font-family:sans-serif;padding:16px"><h1>مزوّد تجريبي (للتطوير فقط)</h1><form method="get">{hidden}
<label>sub <input name="sub" value="dev-1"></label><br><label>email <input name="email" value="dev@example.test"></label><br>
<label>name <input name="name" value="مستخدم تجريبي"></label><br><label><input type="checkbox" name="email_verified" value="true" checked> verified</label><br>
<button>متابعة</button></form></body></html>""")

    def _answer(self, q):
        state, nonce = q.get("state", ""), q.get("nonce", "")
        claims = {"sub": q["sub"], "email": q.get("email", ""), "email_verified": q.get("email_verified") == "true", "name": q.get("name", "")}
        code = oidc.fake_issue_code(state, nonce, claims)
        return redirect(f"{oidc.redirect_uri('fake')}?code={code}&state={quote(state)}")


def urls():
    from django.urls import path

    return [
        path("auth/oauth/providers", OAuthProviders.as_view()),
        path("auth/oauth/finish", OAuthFinish.as_view()),
        path("auth/oauth/signup", OAuthSignup.as_view()),
        path("auth/oauth/confirm", OAuthConfirmLink.as_view()),
        path("auth/oauth/fake/authorize", FakeAuthorize.as_view()),
        path("auth/oauth/<slug:provider>/start", OAuthStart.as_view()),
        path("auth/oauth/<slug:provider>/callback", OAuthCallback.as_view()),
        path("auth/password/set", SetPasswordView.as_view()),
        path("me/auth-methods", MyAuthMethods.as_view()),
        path("me/auth-methods/<slug:provider>", MyAuthMethodDetail.as_view()),
        path("me/sessions", MySessions.as_view()),
        path("me/sessions/end-others", MySessionsEndOthers.as_view()),
        path("me/sessions/<int:pk>", MySessionEnd.as_view()),
    ]
