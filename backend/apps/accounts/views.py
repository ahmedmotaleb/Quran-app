import logging

from django.conf import settings
from django.contrib.auth import authenticate, login, logout, password_validation, update_session_auth_hash
from django.contrib.auth.tokens import default_token_generator
from django.core.cache import cache
from django.core.mail import send_mail
from django.db import transaction
from django.db.models import Count, Prefetch, Q
from django.utils import timezone
from django.utils.encoding import force_bytes, force_str
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode
from django.middleware.csrf import get_token
from django.views.decorators.csrf import ensure_csrf_cookie
from django.utils.decorators import method_decorator
from rest_framework import generics, status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.audit import audit
from apps.core.exceptions import ApiError
from apps.core.models import AppSettings

from . import totp
from .authentication import BearerTokenAuthentication
from .models import (
    AccountStatus, AuthToken, GuardianLink, Invitation, LinkStatus, Role, StudentProfile, TeacherAssignment, TeacherProfile, User,
)
from .permissions import IsAdminRole, IsLearningUser, IsParent, IsStudent, IsTeacher, assigned_student_ids, linked_child_ids
from .serializers import (
    AcceptInvitationSerializer, AdminCreateUserSerializer, AdminUserSerializer, AdminUserUpdateSerializer, GuardianLinkSerializer,
    LoginSerializer, MeSerializer, OnboardingSerializer, RegisterSerializer, StatusChangeSerializer, TeacherAssignmentSerializer,
    TeacherPublicSerializer, TeacherStudentSerializer, arabic_password_error,
)

log = logging.getLogger(__name__)

BAD_CREDENTIALS = ApiError("bad_credentials", "البريد الإلكتروني أو كلمة المرور غير صحيحة.", 400)
LOCKED = ApiError("account_locked", "محاولات دخول كثيرة غير ناجحة. انتظر ربع ساعة ثم حاول مجددًا أو أعد تعيين كلمة المرور.", 429)


def _lock_key(email: str) -> str:
    import hashlib

    return "login-fail:" + hashlib.sha256(email.encode()).hexdigest()[:32]  # no address in the cache table


def _locked(email: str) -> bool:
    return (cache.get(_lock_key(email)) or 0) >= settings.LOGIN_LOCKOUT_FAILURES


def _record_failure(email: str) -> None:
    """Per-account counter, independent of IP, so a spread-out guessing attack is stopped too."""
    k = _lock_key(email)
    if cache.add(k, 1, settings.LOGIN_LOCKOUT_MINUTES * 60):
        return
    try:
        n = cache.incr(k)
    except ValueError:
        n = 1
        cache.set(k, 1, settings.LOGIN_LOCKOUT_MINUTES * 60)
    if n == settings.LOGIN_LOCKOUT_FAILURES:
        audit("auth.locked", email_domain=email.split("@")[-1], minutes=settings.LOGIN_LOCKOUT_MINUTES)
        log.warning("auth_locked", extra={"minutes": settings.LOGIN_LOCKOUT_MINUTES})


def _session_payload(request, user, client: str, device: str):
    data = {"user": MeSerializer(user).data}
    if client == "native":
        _, raw = AuthToken.issue(user, device=device)
        data["token"] = raw  # shown once; the app keeps it in protected device storage
    else:
        login(request, user)
    return data


@method_decorator(ensure_csrf_cookie, name="dispatch")
class CsrfView(APIView):
    """Sets the CSRF cookie for the web app before its first POST."""

    authentication_classes: list = []
    permission_classes = [AllowAny]

    def get(self, request):
        # Also returned in the body: a web app on another origin cannot read the API's cookie.
        return Response({"csrfToken": get_token(request)})


class RegisterView(APIView):
    authentication_classes: list = []
    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def post(self, request):
        if not AppSettings.load().open_signup:
            raise ApiError("signup_closed", "التسجيل العام مغلق حاليًا. تواصل مع إدارة الحلقة.", 403)
        s = RegisterSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        with transaction.atomic():
            user = User.objects.create_user(d["email"], d["password"], full_name=d["full_name"], role=Role.STUDENT, timezone=d["timezone"])
            StudentProfile.objects.create(user=user)
            audit("user.registered", actor=user, target=user, request=request)
        client = request.data.get("client", "web")
        return Response(_session_payload(request, user, client, request.data.get("device", "")), status=status.HTTP_201_CREATED)


class _BaseLogin(APIView):
    authentication_classes: list = []
    permission_classes = [AllowAny]
    throttle_scope = "auth"
    portal = "learning"

    def post(self, request):
        s = LoginSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        email = d["email"].strip().lower()
        if _locked(email):
            raise LOCKED
        user = authenticate(request, username=email, password=d["password"])
        if user is None:
            audit("auth.login_failed", request=request, email_domain=email.split("@")[-1], portal=self.portal)
            log.warning("login_failed", extra={"portal": self.portal})
            _record_failure(email)
            raise BAD_CREDENTIALS
        if user.status in (AccountStatus.SUSPENDED, AccountStatus.ARCHIVED):
            raise ApiError("account_suspended", "تم إيقاف هذا الحساب. تواصل مع إدارة الحلقة.", 403)
        if not user.can_sign_in:
            raise ApiError("account_pending", "حسابك بانتظار اعتماد الإدارة.", 403)
        self.check_portal(user, d)
        cache.delete(_lock_key(email))
        audit("auth.login", actor=user, target=user, request=request, client=d["client"], portal=self.portal)
        if self.portal == "admin" and d["client"] != "native":
            # The portal's own session: signing in here never replaces a learner's session on the same device.
            from .authentication import start_admin_session

            resp = Response({"user": MeSerializer(user).data})
            start_admin_session(request, resp, user)
            if getattr(self, "remember_device", False):
                from . import trusted

                trusted.remember(request, resp, user)
            return resp
        return Response(_session_payload(request, user, d["client"], d["device"]))

    def check_portal(self, user, d):
        if user.role == Role.ADMIN:
            raise ApiError("admin_portal_only", "حساب الإدارة يدخل من بوابة الإدارة المنفصلة.", 403)


class LoginView(_BaseLogin):
    portal = "learning"


class AdminLoginView(_BaseLogin):
    portal = "admin"

    def check_portal(self, user, d):
        if user.role != Role.ADMIN:
            raise ApiError("not_admin", "هذا الحساب لا يملك صلاحيات الإدارة.", 403)
        if user.mfa_enabled and not d["otp"] and d["client"] != "native":
            from . import trusted

            device = trusted.trusted(self.request, user)
            if device is not None:  # a device the admin chose to trust: the password alone is enough
                trusted.use(self.request, device)
                return
        if user.mfa_enabled and not totp.verify(user.mfa_secret, d["otp"]):
            if d["otp"]:
                audit("auth.mfa_failed", actor=user, target=user, request=self.request, portal="admin")
                log.warning("mfa_failed", extra={"portal": "admin"})
                _record_failure(user.email)
            raise ApiError("mfa_required" if not d["otp"] else "mfa_invalid",
                           "أدخل رمز التحقق من تطبيق المصادقة." if not d["otp"] else "رمز التحقق غير صحيح.", 401)
        self.remember_device = bool(user.mfa_enabled and d["trust_device"] and d["client"] != "native")


class LogoutView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        if isinstance(request.auth, AuthToken):
            AuthToken.objects.filter(pk=request.auth.pk).update(revoked_at=timezone.now())
        from .authentication import end_admin_session, is_admin_portal

        resp = Response(status=status.HTTP_204_NO_CONTENT)
        if is_admin_portal(request._request):
            end_admin_session(request, resp)  # the learner session on this device stays signed in
        else:
            logout(request)
        return resp


class MeView(generics.RetrieveUpdateAPIView):
    serializer_class = MeSerializer
    permission_classes = [IsAuthenticated]

    def get_object(self):
        return self.request.user


class OnboardingView(APIView):
    permission_classes = [IsStudent]

    def put(self, request):
        profile, _ = StudentProfile.objects.get_or_create(user=request.user)
        s = OnboardingSerializer(profile, data=request.data)
        s.is_valid(raise_exception=True)
        s.save()
        return Response(MeSerializer(request.user).data)


def password_link(user) -> str:
    """One-use link (expires after PASSWORD_RESET_TIMEOUT) to set a password; used by recovery and admin onboarding."""
    uid = urlsafe_base64_encode(force_bytes(user.pk))
    # `next=parent` only picks the sign-in screen shown afterwards; the role always comes from the server.
    nxt = "&next=parent" if user.role == Role.PARENT else ""
    return f"{settings.FRONTEND_URL}/#/reset?uid={uid}&token={default_token_generator.make_token(user)}{nxt}"


from .emails import email_configured, send_link_email  # noqa: E402,F401  (email_configured is used by admin_bulk)


class PasswordForgotView(APIView):
    """Always answers the same way, whether or not the email exists."""

    authentication_classes: list = []
    permission_classes = [AllowAny]
    throttle_scope = "recovery"

    def post(self, request):
        email = str(request.data.get("email", "")).strip().lower()
        user = User.objects.filter(email=email, is_active=True).first()
        if user and user.status not in (AccountStatus.SUSPENDED, AccountStatus.ARCHIVED):
            link = password_link(user)
            try:
                send_mail("استعادة كلمة المرور — الحلقة", f"لتعيين كلمة مرور جديدة افتح الرابط:\n{link}\n\nالرابط صالح لمرة واحدة. إن لم تطلب ذلك فتجاهل الرسالة.",
                          settings.DEFAULT_FROM_EMAIL, [user.email])
            except Exception as e:  # noqa: BLE001 — the response stays generic; log only the error type, never the link
                log.error("recovery_email_failed", extra={"error": type(e).__name__})
            audit("auth.recovery_requested", actor=user, target=user, request=request)
        return Response({"message": "إن كان البريد مسجلًا لدينا فستصلك رسالة خلال دقائق."})


class PasswordResetView(APIView):
    authentication_classes: list = []
    permission_classes = [AllowAny]
    throttle_scope = "recovery"

    def post(self, request):
        try:
            uid = force_str(urlsafe_base64_decode(str(request.data.get("uid", ""))))
            user = User.objects.get(pk=uid)
        except Exception:
            user = None
        if user is None or not default_token_generator.check_token(user, str(request.data.get("token", ""))):
            raise ApiError("reset_invalid", "رابط الاستعادة غير صالح أو منتهي الصلاحية. اطلب رابطًا جديدًا.", 400)
        pw = str(request.data.get("password", ""))
        try:
            password_validation.validate_password(pw, user)
        except Exception as e:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"password": [arabic_password_error(e)]})
        user.set_password(pw)
        user.save(update_fields=["password"])
        AuthToken.objects.filter(user=user, revoked_at__isnull=True).update(revoked_at=timezone.now())
        audit("auth.password_reset", actor=user, target=user, request=request)
        return Response({"message": "تم تعيين كلمة المرور. سجّل الدخول من جديد."})


class PasswordChangeView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_scope = "auth"  # it checks the current password: limit guessing with a stolen session

    def post(self, request):
        user = request.user
        if not user.check_password(str(request.data.get("current_password", ""))):
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"current_password": ["كلمة المرور الحالية غير صحيحة."]})
        pw = str(request.data.get("new_password", ""))
        try:
            password_validation.validate_password(pw, user)
        except Exception as e:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"new_password": [arabic_password_error(e)]})
        user.set_password(pw)
        user.save(update_fields=["password"])
        # Sign out other devices: revoke all native tokens except the one making this request.
        keep = request.auth.pk if isinstance(request.auth, AuthToken) else None
        AuthToken.objects.filter(user=user, revoked_at__isnull=True).exclude(pk=keep).update(revoked_at=timezone.now())
        if not isinstance(request.auth, AuthToken):
            update_session_auth_hash(request, user)
        audit("auth.password_changed", actor=user, target=user, request=request)
        return Response(status=status.HTTP_204_NO_CONTENT)


# ---- Admin MFA -------------------------------------------------------------------------
class MfaSetupView(APIView):
    permission_classes = [IsAdminRole]
    mfa_setup_view = True
    throttle_scope = "auth"

    def post(self, request):
        u = request.user
        if u.mfa_enabled:
            raise ApiError("mfa_already_enabled", "التحقق بخطوتين مفعّل بالفعل.", 409)
        u.mfa_secret = totp.new_secret()
        u.save(update_fields=["mfa_secret"])
        return Response({"secret": u.mfa_secret, "otpauth_uri": totp.provisioning_uri(u.mfa_secret, u.email)})


class MfaConfirmView(APIView):
    permission_classes = [IsAdminRole]
    mfa_setup_view = True
    throttle_scope = "auth"  # six-digit codes: limit guessing

    def post(self, request):
        u = request.user
        if not u.mfa_secret or not totp.verify(u.mfa_secret, str(request.data.get("otp", ""))):
            audit("auth.mfa_failed", actor=u, target=u, request=request, step="confirm")
            raise ApiError("mfa_invalid", "رمز التحقق غير صحيح.", 400)
        u.mfa_enabled = True
        u.save(update_fields=["mfa_enabled"])
        audit("auth.mfa_enabled", actor=u, target=u, request=request)
        return Response({"mfa_enabled": True})


# ---- Invitations -----------------------------------------------------------------------
class AcceptInvitationView(APIView):
    """
    teacher_account: creates a teacher account (anonymous caller).
    guardian_link: the signed-in parent becomes the verified guardian of the invitation's student.
    student_teacher: the signed-in student is assigned to the inviting teacher.
    """

    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def post(self, request):
        s = AcceptInvitationSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        invalid = ApiError("invitation_invalid", "رمز الدعوة غير صالح أو منتهي الصلاحية.", 400)
        with transaction.atomic():
            inv = Invitation.find(d["code"])
            if inv is None or not inv.usable:
                raise invalid
            user = request.user if request.user.is_authenticated else None
            if inv.email and user and user.email != inv.email:
                raise invalid
            if inv.purpose == Invitation.Purpose.TEACHER_ACCOUNT:
                if user is not None:
                    raise ApiError("sign_out_first", "سجّل الخروج أولًا لإنشاء حساب المعلم.", 400)
                email = (d.get("email") or inv.email or "").lower()
                if not (email and d.get("password") and d.get("full_name")):
                    raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"email": ["مطلوب"], "full_name": ["مطلوب"], "password": ["مطلوب"]})
                if inv.email and email != inv.email:
                    raise invalid
                if User.objects.filter(email=email).exists():
                    raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"email": ["هذا البريد مسجّل بالفعل."]})
                try:
                    password_validation.validate_password(d["password"])
                except Exception as e:
                    raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"password": [arabic_password_error(e)]})
                user = User.objects.create_user(email, d["password"], full_name=d["full_name"], role=Role.TEACHER)
                TeacherProfile.objects.create(user=user, approved_at=timezone.now())
                result = {"user": MeSerializer(user).data}
            elif inv.purpose == Invitation.Purpose.GUARDIAN_LINK:
                if user is None or user.role != Role.PARENT:
                    raise ApiError("parent_required", "سجّل الدخول بحساب ولي الأمر أولًا.", 403)
                link, created = GuardianLink.objects.get_or_create(
                    guardian=user, student=inv.student, status=LinkStatus.ACTIVE,
                    defaults={"created_by": inv.created_by, "approved_by": inv.created_by, "approved_at": timezone.now()},
                )
                result = {"link": GuardianLinkSerializer(link).data}
            else:  # student_teacher
                if user is None or user.role != Role.STUDENT:
                    raise ApiError("student_required", "سجّل الدخول بحساب الطالب أولًا.", 403)
                TeacherAssignment.objects.get_or_create(teacher=inv.teacher, student=user, active=True, defaults={"created_by": inv.teacher})
                result = {"teacher": {"id": inv.teacher_id, "name": inv.teacher.full_name}}
            inv.uses += 1
            inv.save(update_fields=["uses"])
            audit("invitation.accepted", actor=user, target=inv, request=request, purpose=inv.purpose)
        return Response(result, status=201)


# ---- Admin: users, assignments, guardian links -----------------------------------------
def _admin_users():
    return User.objects.exclude(role=Role.ADMIN).exclude(status=AccountStatus.DELETED).select_related("student_profile", "teacher_profile").prefetch_related(
        Prefetch("teacher_assignments", queryset=TeacherAssignment.objects.select_related("teacher")),
        Prefetch("guardians", queryset=GuardianLink.objects.select_related("guardian")),
        Prefetch("guardian_links", queryset=GuardianLink.objects.select_related("student")),
    )


class AdminUserList(generics.ListCreateAPIView):
    permission_classes = [IsAdminRole]

    def get_serializer_class(self):
        return AdminCreateUserSerializer if self.request.method == "POST" else AdminUserSerializer

    def get_queryset(self):
        from .admin_bulk import USER_FILTERS

        # Search, filters and sort are validated and shared with the bulk "all filtered results" mode.
        return USER_FILTERS.run(_admin_users(), self.request.query_params, sort=self.request.query_params.get("sort"))

    def create(self, request, *args, **kwargs):
        s = AdminCreateUserSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        with transaction.atomic():
            # No password is set: the person sets one through the recovery link sent to them.
            user = User.objects.create_user(d["email"], None, full_name=d["full_name"], role=d["role"])
            if user.role == Role.STUDENT:
                StudentProfile.objects.create(user=user)
            audit("admin.user_created", actor=request.user, target=user, request=request, role=user.role)
        return Response({**AdminUserSerializer(user).data, **_setup_link(request, user)}, status=201)


def _setup_link(request, user) -> dict:
    """Email the password-setup link; without an email provider the admin gets it to pass on in person."""
    link = password_link(user)
    role = {Role.PARENT: "ولي أمر", Role.TEACHER: "معلم"}.get(user.role, "طالب")
    sent = send_link_email(user.email, subject="إعداد حسابك في حَلْقة",
                           intro=f"أُنشئ لك حساب {role} في حَلْقة لتحفيظ القرآن الكريم. اختر كلمة مرور لحسابك من الرابط التالي، ثم سجّل الدخول.",
                           cta="تعيين كلمة المرور", link=link, expires_at=None)
    audit("admin.setup_link_issued", actor=request.user, target=user, request=request, emailed=sent)
    return {"setup_email_sent": sent, "setup_link": None if sent else link}


class AdminUserDetail(APIView):
    """Edit a learner/teacher/parent profile (not email, role or password)."""

    permission_classes = [IsAdminRole]

    def get(self, request, pk):
        return Response(AdminUserSerializer(generics.get_object_or_404(_admin_users(), pk=pk)).data)

    def patch(self, request, pk):
        user = generics.get_object_or_404(User.objects.exclude(role=Role.ADMIN).exclude(status=AccountStatus.DELETED), pk=pk)
        s = AdminUserUpdateSerializer(data=request.data, partial=True)
        s.is_valid(raise_exception=True)
        changed = sorted(k for k, v in s.validated_data.items() if getattr(user, k) != v)
        for k in changed:
            setattr(user, k, s.validated_data[k])
        if changed:
            user.save(update_fields=changed)
            audit("admin.user_updated", actor=request.user, target=user, request=request, fields=changed)
        return Response(AdminUserSerializer(_admin_users().get(pk=pk)).data)


class AdminUserSetupLink(APIView):
    """New password-setup link for a user (e.g. a parent who never set one, or lost access)."""

    permission_classes = [IsAdminRole]

    def post(self, request, pk):
        user = generics.get_object_or_404(User.objects.exclude(role=Role.ADMIN), pk=pk, is_active=True)
        if user.status in (AccountStatus.SUSPENDED, AccountStatus.ARCHIVED):
            raise ApiError("suspended", "الحساب موقوف أو مؤرشف. أعد تفعيله أولًا.", 409)
        return Response(_setup_link(request, user))


class AdminUserCounts(APIView):
    """Status counts per role, for the filter chips."""

    permission_classes = [IsAdminRole]

    def get(self, request):
        qs = User.objects.exclude(role=Role.ADMIN).exclude(status=AccountStatus.DELETED)
        if request.query_params.get("role"):
            qs = qs.filter(role=request.query_params["role"])
        out = {s: 0 for s in AccountStatus.values if s != AccountStatus.DELETED}
        for r in qs.values("status").annotate(n=Count("id")):
            out[r["status"]] = r["n"]
        out["all"] = sum(n for s, n in out.items() if s != AccountStatus.ARCHIVED)  # "all" = everyone not archived
        if request.query_params.get("role") == Role.TEACHER:
            out["unapproved"] = qs.exclude(status=AccountStatus.ARCHIVED).filter(Q(teacher_profile__isnull=True) | Q(teacher_profile__approved_at__isnull=True)).count()
        if request.query_params.get("role") == Role.STUDENT:
            out["unlinked"] = qs.exclude(status=AccountStatus.ARCHIVED).exclude(teacher_assignments__active=True).count()
        return Response(out)


class AdminTeacherApproval(APIView):
    """Approve a teacher so learners can find and book them; `{"approved": false, "reason": …}` withdraws it."""

    permission_classes = [IsAdminRole]

    def post(self, request, pk):
        t = generics.get_object_or_404(User, pk=pk, role=Role.TEACHER)
        approve = request.data.get("approved", True) not in (False, "false", 0, "0")
        reason = str(request.data.get("reason", "")).strip()[:200]
        if not approve and len(reason) < 3:
            raise ApiError("invalid", "اكتب سبب سحب الاعتماد.", 400, {"reason": ["اكتب سبب سحب الاعتماد."]})
        prof, _ = TeacherProfile.objects.get_or_create(user=t)
        prof.approved_at = timezone.now() if approve else None
        prof.save(update_fields=["approved_at"])
        if approve and t.status == AccountStatus.PENDING:
            t.status = AccountStatus.ACTIVE
            t.save(update_fields=["status"])
        audit("admin.teacher_approval", actor=request.user, target=t, request=request, approved=approve, reason=reason)
        return Response(AdminUserSerializer(_admin_users().get(pk=pk)).data)


class AdminUserStatus(APIView):
    permission_classes = [IsAdminRole]

    def post(self, request, pk):
        user = generics.get_object_or_404(User.objects.exclude(role=Role.ADMIN).exclude(status=AccountStatus.DELETED), pk=pk)
        s = StatusChangeSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        old = user.status
        user.status = s.validated_data["status"]
        user.save(update_fields=["status"])
        if user.status in (AccountStatus.SUSPENDED, AccountStatus.ARCHIVED):
            # Sessions are re-checked on every request; native tokens are revoked outright.
            AuthToken.objects.filter(user=user, revoked_at__isnull=True).update(revoked_at=timezone.now())
        audit("admin.user_status", actor=request.user, target=user, request=request, old=old, new=user.status, reason=s.validated_data["reason"])
        return Response(AdminUserSerializer(_admin_users().get(pk=pk)).data)


class AdminAssignmentCreate(generics.CreateAPIView):
    permission_classes = [IsAdminRole]
    serializer_class = TeacherAssignmentSerializer

    def perform_create(self, serializer):
        d = serializer.validated_data
        if TeacherAssignment.objects.filter(teacher=d["teacher"], student=d["student"], active=True).exists():
            raise ApiError("already_assigned", "الطالب مرتبط بهذا المعلم بالفعل.", 409)
        obj = serializer.save(created_by=self.request.user)
        audit("admin.teacher_assigned", actor=self.request.user, target=obj, request=self.request)


class AdminAssignmentEnd(APIView):
    permission_classes = [IsAdminRole]

    def post(self, request, pk):
        a = generics.get_object_or_404(TeacherAssignment, pk=pk, active=True)
        a.active, a.ended_at = False, timezone.now()
        a.save(update_fields=["active", "ended_at"])
        audit("admin.teacher_unassigned", actor=request.user, target=a, request=request)
        return Response(status=204)


class AdminGuardianLinkCreate(generics.CreateAPIView):
    """Admin process for verified guardian links (alternative to invitations)."""

    permission_classes = [IsAdminRole]
    serializer_class = GuardianLinkSerializer

    def perform_create(self, serializer):
        d = serializer.validated_data
        if GuardianLink.objects.filter(guardian=d["guardian"], student=d["student"]).exclude(status=LinkStatus.REVOKED).exists():
            raise ApiError("already_linked", "ولي الأمر مرتبط بهذا الطالب بالفعل.", 409)
        obj = serializer.save(status=LinkStatus.ACTIVE, created_by=self.request.user, approved_by=self.request.user, approved_at=timezone.now())
        audit("admin.guardian_linked", actor=self.request.user, target=obj, request=self.request)


class AdminGuardianLinkRevoke(APIView):
    permission_classes = [IsAdminRole]

    def post(self, request, pk):
        link = generics.get_object_or_404(GuardianLink.objects.exclude(status=LinkStatus.REVOKED), pk=pk)
        link.status, link.revoked_at = LinkStatus.REVOKED, timezone.now()
        link.save(update_fields=["status", "revoked_at"])
        audit("admin.guardian_revoked", actor=request.user, target=link, request=request, reason=str(request.data.get("reason", ""))[:200])
        return Response(status=204)


# ---- Role views ----------------------------------------------------------------------
class TeacherDirectory(generics.ListAPIView):
    """Approved, active teachers that learners can browse and book."""

    permission_classes = [IsLearningUser]
    serializer_class = TeacherPublicSerializer

    def get_queryset(self):
        qs = User.objects.filter(role=Role.TEACHER, status=AccountStatus.ACTIVE, is_active=True,
                                 teacher_profile__approved_at__isnull=False).select_related("teacher_profile").order_by("full_name")
        q = self.request.query_params.get("q")
        if q:
            qs = qs.filter(Q(full_name__icontains=q) | Q(teacher_profile__specialization__icontains=q))
        tag = self.request.query_params.get("tag")
        if tag:
            qs = qs.filter(teacher_profile__tags__contains=[tag])
        return qs


class TeacherDetail(generics.RetrieveAPIView):
    permission_classes = [IsLearningUser]
    serializer_class = TeacherPublicSerializer

    def get_queryset(self):
        return TeacherDirectory.get_queryset(self)


class MyStudents(generics.ListAPIView):
    permission_classes = [IsTeacher]
    serializer_class = TeacherStudentSerializer

    def get_queryset(self):
        return User.objects.filter(pk__in=assigned_student_ids(self.request.user)).select_related("student_profile").prefetch_related(
            "guardians").order_by("full_name")


class MyChildren(generics.ListAPIView):
    permission_classes = [IsParent]
    serializer_class = MeSerializer

    def get_queryset(self):
        return User.objects.filter(pk__in=linked_child_ids(self.request.user), status=AccountStatus.ACTIVE).order_by("full_name")


# Re-exported for tests that need to call bearer auth directly.
__all__ = ["BearerTokenAuthentication"]
