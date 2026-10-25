import zoneinfo

from django.contrib.auth import password_validation
from rest_framework import serializers

from .models import AccountStatus, GuardianLink, Invitation, Role, StudentProfile, TeacherAssignment, TeacherProfile, User


def validate_tz(value: str) -> str:
    if value not in zoneinfo.available_timezones():
        raise serializers.ValidationError("منطقة زمنية غير معروفة.")
    return value


def _student_field(u, name: str) -> str:
    """Student profile details only for a student: a promoted teacher keeps the old profile as history only."""
    if u.role != Role.STUDENT:
        return ""
    return getattr(getattr(u, "student_profile", None), name, "") or ""


class MeSerializer(serializers.ModelSerializer):
    level = serializers.SerializerMethodField()
    daily_goal = serializers.SerializerMethodField()
    mfa_required = serializers.SerializerMethodField()
    admin_access = serializers.SerializerMethodField()
    phone_verified = serializers.SerializerMethodField()
    teacher_approved = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ["id", "email", "full_name", "display_name", "gender", "role", "status", "timezone", "phone", "phone_verified", "mfa_enabled",
                  "mfa_required", "level", "daily_goal", "date_joined", "admin_access", "teacher_approved", "notify_prefs"]
        # Only the name, gender (a teacher's title), time zone and contact phone change here. Role, status, email and two-step verification have
        # their own audited flows (a misplaced list let `PATCH me` change them on 22–23 Oct; test_me_protected_fields).
        read_only_fields = ["id", "email", "display_name", "role", "status", "mfa_enabled", "date_joined"]

    def get_level(self, u) -> str:
        return _student_field(u, "level")

    def get_daily_goal(self, u) -> str:
        return _student_field(u, "daily_goal")

    def get_phone_verified(self, u) -> bool:
        return bool(u.phone_verified_at and u.phone_e164)

    def validate_notify_prefs(self, v):
        from apps.notifications.push import PREF_KEYS

        if not isinstance(v, dict) or any(k not in PREF_KEYS or not isinstance(x, bool) for k, x in v.items()):
            raise serializers.ValidationError("إعدادات إشعارات غير صالحة.")
        return {**(self.instance.notify_prefs if self.instance else {}), **v}

    def get_teacher_approved(self, u):
        """Teachers only: approved by an admin (visible to students). None for other roles."""
        if u.role != Role.TEACHER:
            return None
        prof = getattr(u, "teacher_profile", None)
        return bool(prof and prof.approved_at)

    def validate_full_name(self, v):
        # A teacher's title is shown, never stored (display.py): «الشيخ أحمد» is saved as «أحمد».
        from .display import strip_title

        return strip_title(v) if self.instance is not None and self.instance.role == "teacher" else v

    def validate_phone(self, v):
        # A verified sign-in number changes only through «تأكيد رقم الهاتف» (the new number is verified first).
        u = self.instance
        if u is not None and u.phone_verified_at and (v or "").strip() != (u.phone or ""):
            raise serializers.ValidationError("غيّر رقمك المؤكد من «تأكيد رقم الهاتف»؛ يُؤكَّد الرقم الجديد قبل استبدال القديم.")
        return v

    def get_mfa_required(self, u) -> bool:
        from .admin_access import mfa_required

        from .admin_access import has_admin_access

        return has_admin_access(u) and mfa_required(u)

    def get_admin_access(self, u):
        from .admin_access import access_out

        return access_out(u)

    def validate_timezone(self, v):
        return validate_tz(v)


class RegisterSerializer(serializers.Serializer):
    """Public sign-up. Always creates a student — there is deliberately no role field."""

    full_name = serializers.CharField(min_length=2, max_length=120, trim_whitespace=True,
                                      error_messages={"min_length": "أدخل اسمك الكامل.", "blank": "أدخل اسمك الكامل."})
    email = serializers.EmailField(error_messages={"invalid": "صيغة البريد الإلكتروني غير صحيحة.", "blank": "أدخل بريدك الإلكتروني."})
    password = serializers.CharField(write_only=True, trim_whitespace=False)
    timezone = serializers.CharField(required=False, default="Africa/Cairo")
    gender = serializers.ChoiceField(choices=["male", "female"], error_messages={
        "required": "اختر: ذكر أو أنثى.", "invalid_choice": "اختر: ذكر أو أنثى.", "null": "اختر: ذكر أو أنثى."})

    def validate_email(self, v):
        v = v.strip().lower()
        if User.objects.filter(email=v).exists():
            raise serializers.ValidationError("هذا البريد مسجّل بالفعل. سجّل الدخول بدلًا من ذلك.")
        return v

    def validate_timezone(self, v):
        return validate_tz(v)

    def validate(self, attrs):
        try:
            password_validation.validate_password(attrs["password"], User(email=attrs["email"], full_name=attrs["full_name"]))
        except Exception as e:  # django ValidationError
            raise serializers.ValidationError({"password": [arabic_password_error(e)]})
        return attrs


def arabic_password_error(exc) -> str:
    codes = {getattr(e, "code", "") for e in getattr(exc, "error_list", [])}
    if "password_too_short" in codes:
        return "استخدم 10 أحرف على الأقل."
    if "password_too_common" in codes:
        return "كلمة المرور شائعة جدًا. اختر كلمة أقوى."
    if "password_entirely_numeric" in codes:
        return "لا تستخدم أرقامًا فقط في كلمة المرور."
    if "password_too_similar" in codes:
        return "كلمة المرور قريبة جدًا من اسمك أو بريدك."
    return "كلمة المرور غير مقبولة."


class LoginSerializer(serializers.Serializer):
    # «البريد الإلكتروني أو رقم الهاتف». `email` is still accepted from older app versions.
    identifier = serializers.CharField(required=False, allow_blank=True, max_length=254, trim_whitespace=True)
    email = serializers.CharField(required=False, allow_blank=True, max_length=254)
    password = serializers.CharField(trim_whitespace=False)
    client = serializers.ChoiceField(choices=["web", "native"], default="web")
    device = serializers.CharField(required=False, allow_blank=True, max_length=120, default="")
    otp = serializers.CharField(required=False, allow_blank=True, max_length=8, default="")
    trust_device = serializers.BooleanField(required=False, default=False)  # admin portal: skip the code here for 30 days

    def validate(self, attrs):
        ident = (attrs.get("identifier") or attrs.get("email") or "").strip()
        if not ident:
            raise serializers.ValidationError({"identifier": ["اكتب البريد الإلكتروني أو رقم الهاتف."]})
        attrs["identifier"] = ident
        return attrs


class OnboardingSerializer(serializers.ModelSerializer):
    class Meta:
        model = StudentProfile
        fields = ["level", "daily_goal", "preferred_days", "preferred_period"]


class AdminUserSerializer(serializers.ModelSerializer):
    teachers = serializers.SerializerMethodField()
    guardians = serializers.SerializerMethodField()
    children = serializers.SerializerMethodField()
    level = serializers.SerializerMethodField()
    approved = serializers.SerializerMethodField()
    has_password = serializers.SerializerMethodField()
    phone_verified = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ["id", "email", "full_name", "display_name", "gender", "role", "status", "timezone", "phone", "phone_verified", "level", "approved", "has_password",
                  "date_joined", "last_login", "teachers", "guardians", "children", "status_reason", "status_changed_at",
                  "setup_email_status", "setup_email_last_at", "setup_email_count"]
        read_only_fields = fields

    def to_representation(self, u):
        # Full phone numbers only with `users.view_contact` (masked otherwise, and when no request is given).
        from .admin_access import has
        from .phones import mask

        out = super().to_representation(u)
        req = self.context.get("request")
        if out.get("phone") and not (req is not None and has(req.user, "users.view_contact")):
            out["phone"] = mask(u.phone_e164 or out["phone"])
        return out

    def get_phone_verified(self, u) -> bool:
        return bool(u.phone_verified_at and u.phone_e164)

    def get_teachers(self, u):
        return [{"id": a.teacher_id, "name": a.teacher.display_name, "assignment_id": a.id} for a in u.teacher_assignments.all() if a.active]

    def get_guardians(self, u):
        return [{"id": g.guardian_id, "name": g.guardian.full_name, "status": g.status, "link_id": g.id}
                for g in u.guardians.all() if g.status != "revoked"]

    def get_children(self, u):
        return [{"id": g.student_id, "name": g.student.full_name, "status": g.status, "link_id": g.id}
                for g in u.guardian_links.all() if g.status != "revoked"]

    def get_level(self, u) -> str:
        return _student_field(u, "level")

    def get_approved(self, u):
        if u.role != Role.TEACHER:
            return None
        prof = getattr(u, "teacher_profile", None)
        return bool(prof and prof.approved_at)

    def get_has_password(self, u):
        return u.has_usable_password()


class AdminUserUpdateSerializer(serializers.Serializer):
    full_name = serializers.CharField(min_length=2, max_length=120, required=False)
    gender = serializers.ChoiceField(choices=["male", "female", ""], required=False)  # a teacher's title
    phone = serializers.CharField(max_length=32, required=False, allow_blank=True)
    timezone = serializers.CharField(max_length=64, required=False)

    def validate_timezone(self, v):
        return validate_tz(v)


class AdminCreateUserSerializer(serializers.Serializer):
    full_name = serializers.CharField(min_length=2, max_length=120)
    email = serializers.EmailField()
    role = serializers.ChoiceField(choices=[Role.STUDENT, Role.PARENT])  # teachers join by invitation; admins via ops

    def validate_email(self, v):
        v = v.strip().lower()
        if User.objects.filter(email=v).exists():
            raise serializers.ValidationError("هذا البريد مستخدم لحساب آخر.")
        return v


class StatusChangeSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=AccountStatus.choices)
    reason = serializers.CharField(max_length=200, required=False, allow_blank=True, default="")

    def validate(self, attrs):
        if attrs["status"] in (AccountStatus.SUSPENDED, AccountStatus.ARCHIVED) and not attrs["reason"].strip():
            raise serializers.ValidationError({"reason": ["اذكر سبب الإيقاف أو الأرشفة."]})
        return attrs


class TeacherAssignmentSerializer(serializers.ModelSerializer):
    class Meta:
        model = TeacherAssignment
        fields = ["id", "teacher", "student", "active", "created_at"]
        read_only_fields = ["id", "active", "created_at"]
        validators: list = []  # the view answers duplicates with a clear 409 in Arabic

    def validate(self, attrs):
        if attrs["teacher"].role != Role.TEACHER:
            raise serializers.ValidationError({"teacher": ["الحساب المختار ليس معلمًا."]})
        if attrs["student"].role != Role.STUDENT:
            raise serializers.ValidationError({"student": ["الحساب المختار ليس طالبًا."]})
        return attrs


class GuardianLinkSerializer(serializers.ModelSerializer):
    guardian_name = serializers.CharField(source="guardian.full_name", read_only=True)
    student_name = serializers.CharField(source="student.full_name", read_only=True)

    class Meta:
        model = GuardianLink
        fields = ["id", "guardian", "guardian_name", "student", "student_name", "status", "approved_at", "created_at"]
        read_only_fields = ["id", "status", "approved_at", "created_at"]

    def validate(self, attrs):
        if attrs["guardian"].role != Role.PARENT:
            raise serializers.ValidationError({"guardian": ["الحساب المختار ليس ولي أمر."]})
        if attrs["student"].role != Role.STUDENT:
            raise serializers.ValidationError({"student": ["الحساب المختار ليس طالبًا."]})
        return attrs


class InvitationCreateSerializer(serializers.Serializer):
    purpose = serializers.ChoiceField(choices=Invitation.Purpose.choices)
    email = serializers.EmailField(required=False, allow_blank=True, default="")
    student = serializers.PrimaryKeyRelatedField(queryset=User.objects.filter(role=Role.STUDENT), required=False, allow_null=True)
    days = serializers.IntegerField(min_value=1, max_value=30, default=7)

    def validate(self, attrs):
        if attrs["purpose"] == Invitation.Purpose.GUARDIAN_LINK and not attrs.get("student"):
            raise serializers.ValidationError({"student": ["حدّد الطالب المراد ربطه."]})
        return attrs


class AcceptInvitationSerializer(serializers.Serializer):
    code = serializers.CharField(max_length=64)
    # Only for creating a new account through the invitation:
    full_name = serializers.CharField(required=False, min_length=2, max_length=120)
    email = serializers.EmailField(required=False)
    password = serializers.CharField(required=False, trim_whitespace=False)
    gender = serializers.ChoiceField(choices=["male", "female"], required=False)  # a new teacher's title (required there)


class TeacherPublicSerializer(serializers.ModelSerializer):
    specialization = serializers.CharField(source="teacher_profile.specialization", default="")
    bio = serializers.CharField(source="teacher_profile.bio", default="")
    audience = serializers.CharField(source="teacher_profile.audience", default="")
    levels = serializers.CharField(source="teacher_profile.levels", default="")
    tags = serializers.JSONField(source="teacher_profile.tags", default=list)
    offers_individual = serializers.BooleanField(source="teacher_profile.offers_individual", default=True)
    offers_group = serializers.BooleanField(source="teacher_profile.offers_group", default=False)

    class Meta:
        model = User
        fields = ["id", "full_name", "display_name", "gender", "timezone", "specialization", "bio", "audience", "levels", "tags",
                  "offers_individual", "offers_group"]


class TeacherProfileSerializer(serializers.ModelSerializer):
    class Meta:
        model = TeacherProfile
        fields = ["specialization", "bio", "audience", "levels", "tags", "offers_individual", "offers_group"]


class TeacherStudentSerializer(serializers.ModelSerializer):
    """What a teacher needs about an assigned student — no contact details or guardian identities."""

    level = serializers.CharField(source="student_profile.level", read_only=True, default="")
    birth_year = serializers.IntegerField(source="student_profile.birth_year", read_only=True, default=None)
    guardian_linked = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ["id", "full_name", "level", "birth_year", "guardian_linked"]

    def get_guardian_linked(self, u) -> bool:
        return any(g.status == "active" for g in u.guardians.all())
