import zoneinfo

from django.contrib.auth import password_validation
from rest_framework import serializers

from .models import AccountStatus, GuardianLink, Invitation, Role, StudentProfile, TeacherAssignment, TeacherProfile, User


def validate_tz(value: str) -> str:
    if value not in zoneinfo.available_timezones():
        raise serializers.ValidationError("منطقة زمنية غير معروفة.")
    return value


class MeSerializer(serializers.ModelSerializer):
    level = serializers.CharField(source="student_profile.level", read_only=True, default="")
    daily_goal = serializers.CharField(source="student_profile.daily_goal", read_only=True, default="")

    class Meta:
        model = User
        fields = ["id", "email", "full_name", "role", "status", "timezone", "phone", "mfa_enabled", "level", "daily_goal", "date_joined"]
        read_only_fields = ["id", "email", "role", "status", "mfa_enabled", "date_joined"]

    def validate_timezone(self, v):
        return validate_tz(v)


class RegisterSerializer(serializers.Serializer):
    """Public sign-up. Always creates a student — there is deliberately no role field."""

    full_name = serializers.CharField(min_length=2, max_length=120, trim_whitespace=True,
                                      error_messages={"min_length": "أدخل اسمك الكامل.", "blank": "أدخل اسمك الكامل."})
    email = serializers.EmailField(error_messages={"invalid": "صيغة البريد الإلكتروني غير صحيحة.", "blank": "أدخل بريدك الإلكتروني."})
    password = serializers.CharField(write_only=True, trim_whitespace=False)
    timezone = serializers.CharField(required=False, default="Africa/Cairo")

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
    email = serializers.EmailField()
    password = serializers.CharField(trim_whitespace=False)
    client = serializers.ChoiceField(choices=["web", "native"], default="web")
    device = serializers.CharField(required=False, allow_blank=True, max_length=120, default="")
    otp = serializers.CharField(required=False, allow_blank=True, max_length=8, default="")


class OnboardingSerializer(serializers.ModelSerializer):
    class Meta:
        model = StudentProfile
        fields = ["level", "daily_goal", "preferred_days", "preferred_period"]


class AdminUserSerializer(serializers.ModelSerializer):
    teachers = serializers.SerializerMethodField()
    guardians = serializers.SerializerMethodField()
    children = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ["id", "email", "full_name", "role", "status", "timezone", "date_joined", "teachers", "guardians", "children"]
        read_only_fields = fields

    def get_teachers(self, u):
        return [{"id": a.teacher_id, "name": a.teacher.full_name} for a in u.teacher_assignments.all() if a.active]

    def get_guardians(self, u):
        return [{"id": g.guardian_id, "name": g.guardian.full_name, "status": g.status} for g in u.guardians.all() if g.status != "revoked"]

    def get_children(self, u):
        return [{"id": g.student_id, "name": g.student.full_name, "status": g.status} for g in u.guardian_links.all() if g.status != "revoked"]


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
        if attrs["status"] == AccountStatus.SUSPENDED and not attrs["reason"].strip():
            raise serializers.ValidationError({"reason": ["اذكر سبب الإيقاف."]})
        return attrs


class TeacherAssignmentSerializer(serializers.ModelSerializer):
    class Meta:
        model = TeacherAssignment
        fields = ["id", "teacher", "student", "active", "created_at"]
        read_only_fields = ["id", "active", "created_at"]

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
        fields = ["id", "full_name", "timezone", "specialization", "bio", "audience", "levels", "tags", "offers_individual", "offers_group"]


class TeacherProfileSerializer(serializers.ModelSerializer):
    class Meta:
        model = TeacherProfile
        fields = ["specialization", "bio", "audience", "levels", "tags", "offers_individual", "offers_group"]
