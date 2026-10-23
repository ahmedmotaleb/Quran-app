import hashlib
import secrets
from datetime import timedelta

from django.conf import settings
from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models
from django.db.models import Q
from django.db.models.functions import Lower
from django.utils import timezone as dj_tz

from apps.core.models import TimeStamped


class Role(models.TextChoices):
    STUDENT = "student", "طالب"
    TEACHER = "teacher", "معلم"
    PARENT = "parent", "ولي أمر"
    ADMIN = "admin", "إدارة"


class AccountStatus(models.TextChoices):
    PENDING = "pending", "بانتظار الاعتماد"
    ACTIVE = "active", "نشط"
    SUSPENDED = "suspended", "موقوف"
    # Soft delete: cannot sign in or recover a password; every record of the person (tasks, recordings
    # metadata, feedback, attendance, audit) is kept. An admin can reactivate the account.
    ARCHIVED = "archived", "مؤرشف"
    # Permanently deleted (see accounts/erase.py): personal data erased, records kept anonymous. Never reactivated.
    DELETED = "deleted", "محذوف"


class UserManager(BaseUserManager):
    use_in_migrations = True

    def _create(self, email, password, **extra):
        if not email:
            raise ValueError("email is required")
        user = self.model(email=self.normalize_email(email).lower(), **extra)
        user.set_password(password)
        user.full_clean(exclude=["password"])
        user.save(using=self._db)
        return user

    def create_user(self, email, password=None, **extra):
        extra.setdefault("role", Role.STUDENT)
        return self._create(email, password, **extra)

    def create_superuser(self, email, password=None, **extra):
        extra.update(role=Role.ADMIN, is_staff=True, is_superuser=True, status=AccountStatus.ACTIVE)
        return self._create(email, password, **extra)


class User(AbstractBaseUser, PermissionsMixin):
    """One identity system for all roles. The role is set by the server, never by the client."""

    email = models.EmailField(max_length=254, unique=True)  # always stored lowercase (see save)
    full_name = models.CharField(max_length=120)
    role = models.CharField(max_length=16, choices=Role.choices, default=Role.STUDENT)
    status = models.CharField(max_length=16, choices=AccountStatus.choices, default=AccountStatus.ACTIVE)
    timezone = models.CharField(max_length=64, default="Africa/Cairo")
    phone = models.CharField(max_length=32, blank=True)  # contact number as entered (E.164 once verified)
    # Sign-in phone (phones.py): E.164, a sign-in identifier only once verified by a code; unique among verified numbers.
    phone_e164 = models.CharField(max_length=20, blank=True, default="")
    phone_verified_at = models.DateTimeField(null=True, blank=True)
    # Password-setup email for accounts created by an admin (teacher, student, parent): last delivery result, when, how
    # many times. Shown in the admin record so a failed or ignored email is visible and can be resent.
    setup_email_status = models.CharField(max_length=8, blank=True, default="")  # "" / sent / failed / pending (queued)
    setup_email_last_at = models.DateTimeField(null=True, blank=True)
    setup_email_count = models.PositiveSmallIntegerField(default=0)
    # «الإشعارات» switches (tasks / sessions / feedback / news): false = no phone push for that category (the in-app
    # notification is still kept). Account and attendance notices are always pushed (apps.notifications.push).
    notify_prefs = models.JSONField(default=dict, blank=True)
    is_active = models.BooleanField(default=True)  # False only for closed accounts; suspension uses `status`.
    # Why the current status was set (shown to admins), e.g. the automatic absence suspension.
    status_reason = models.CharField(max_length=200, blank=True)
    status_changed_at = models.DateTimeField(null=True, blank=True)
    is_staff = models.BooleanField(default=False)  # Django admin site access (ops only).
    date_joined = models.DateTimeField(default=dj_tz.now)
    # Admin MFA (TOTP). The secret is server-side only; enabling requires confirming a code.
    mfa_secret = models.CharField(max_length=64, blank=True)
    mfa_enabled = models.BooleanField(default=False)

    objects = UserManager()
    USERNAME_FIELD = "email"
    EMAIL_FIELD = "email"
    REQUIRED_FIELDS = ["full_name"]

    class Meta:
        constraints = [
            models.UniqueConstraint(Lower("email"), name="user_email_ci_unique"),
            models.UniqueConstraint(fields=["phone_e164"], condition=models.Q(phone_verified_at__isnull=False) & ~models.Q(phone_e164=""),
                                    name="user_verified_phone_unique"),
        ]
        indexes = [models.Index(fields=["role", "status"]), models.Index(fields=["phone_e164"], name="user_phone_e164_idx")]

    def __str__(self):
        return f"{self.full_name} <{self.email}>"

    def save(self, *args, **kwargs):
        self.email = (self.email or "").strip().lower()
        super().save(*args, **kwargs)

    @property
    def can_sign_in(self) -> bool:
        return self.is_active and self.status == AccountStatus.ACTIVE


class StudentProfile(TimeStamped):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="student_profile")
    level = models.CharField(max_length=32, blank=True)  # مبتدئ / متوسط / متقدم
    daily_goal = models.CharField(max_length=64, blank=True)
    preferred_days = models.JSONField(default=list, blank=True)
    preferred_period = models.CharField(max_length=16, blank=True)
    birth_year = models.PositiveSmallIntegerField(null=True, blank=True)


class TeacherProfile(TimeStamped):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="teacher_profile")
    specialization = models.CharField(max_length=120, blank=True)
    bio = models.TextField(blank=True)
    audience = models.CharField(max_length=120, blank=True)
    levels = models.CharField(max_length=120, blank=True)
    tags = models.JSONField(default=list, blank=True)
    offers_individual = models.BooleanField(default=True)
    offers_group = models.BooleanField(default=False)
    approved_at = models.DateTimeField(null=True, blank=True)


class TeacherAssignment(TimeStamped):
    """A teacher is responsible for a student. Teachers only see students assigned to them."""

    teacher = models.ForeignKey(User, on_delete=models.PROTECT, related_name="assigned_students", limit_choices_to={"role": Role.TEACHER})
    student = models.ForeignKey(User, on_delete=models.PROTECT, related_name="teacher_assignments", limit_choices_to={"role": Role.STUDENT})
    active = models.BooleanField(default=True)
    created_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    ended_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["teacher", "student"], condition=Q(active=True), name="one_active_assignment_per_pair")]


class LinkStatus(models.TextChoices):
    PENDING = "pending", "بانتظار الاعتماد"
    ACTIVE = "active", "فعّال"
    REVOKED = "revoked", "ملغى"


class GuardianLink(TimeStamped):
    """Verified parent↔child relationship. Only ACTIVE links grant access."""

    guardian = models.ForeignKey(User, on_delete=models.PROTECT, related_name="guardian_links", limit_choices_to={"role": Role.PARENT})
    student = models.ForeignKey(User, on_delete=models.PROTECT, related_name="guardians", limit_choices_to={"role": Role.STUDENT})
    status = models.CharField(max_length=16, choices=LinkStatus.choices, default=LinkStatus.PENDING)
    created_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    approved_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    approved_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["guardian", "student"], condition=~Q(status="revoked"), name="one_open_link_per_pair"),
        ]


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


class Invitation(TimeStamped):
    """Single- or limited-use code to join as teacher/parent or to link to a student. Only the hash is stored."""

    class Purpose(models.TextChoices):
        TEACHER_ACCOUNT = "teacher_account", "حساب معلم"
        GUARDIAN_LINK = "guardian_link", "ربط ولي أمر"
        STUDENT_TEACHER = "student_teacher", "انضمام طالب لمعلم"
        ADMIN_ACCOUNT = "admin_account", "حساب مسؤول"

    purpose = models.CharField(max_length=32, choices=Purpose.choices)
    code_hash = models.CharField(max_length=64, unique=True)
    email = models.EmailField(blank=True)  # optional: restrict to this address
    student = models.ForeignKey(User, null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    teacher = models.ForeignKey(User, null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    created_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="+")
    expires_at = models.DateTimeField()
    max_uses = models.PositiveSmallIntegerField(default=1)
    uses = models.PositiveSmallIntegerField(default=0)
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoke_reason = models.CharField(max_length=20, blank=True)  # "replaced" when a resend issued a new code
    # Delivery metadata only (never the link or code).
    email_status = models.CharField(max_length=8, blank=True)    # "", "sent", "failed"
    last_sent_at = models.DateTimeField(null=True, blank=True)
    send_count = models.PositiveSmallIntegerField(default=0)
    # admin_account only: the access the new admin gets (validated by admin_access when the invitation is made).
    admin_level = models.CharField(max_length=8, blank=True)
    admin_preset = models.CharField(max_length=24, blank=True)
    admin_permissions = models.JSONField(default=list, blank=True)

    @property
    def status(self) -> str:
        if self.uses >= self.max_uses:
            return "accepted"
        if self.revoked_at:
            return "revoked"
        if self.expires_at <= dj_tz.now():
            return "expired"
        return "failed" if self.email_status == "failed" else "pending"

    @classmethod
    def issue(cls, *, purpose, created_by, days=7, **fields) -> tuple["Invitation", str]:
        raw = secrets.token_urlsafe(9)  # ~12 chars, shown once
        inv = cls.objects.create(purpose=purpose, code_hash=_hash(raw), created_by=created_by,
                                 expires_at=dj_tz.now() + timedelta(days=days), **fields)
        return inv, raw

    @classmethod
    def find(cls, raw: str):
        return cls.objects.select_for_update().filter(code_hash=_hash(raw.strip())).first()

    @property
    def usable(self) -> bool:
        return self.revoked_at is None and self.uses < self.max_uses and self.expires_at > dj_tz.now()


class AuthToken(models.Model):
    """Bearer token for native clients. Only a SHA-256 hash is stored; revocable and expiring."""

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="auth_tokens")
    key_hash = models.CharField(max_length=64, unique=True)
    prefix = models.CharField(max_length=8)  # for display/revocation lists, not secret
    device = models.CharField(max_length=120, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True, blank=True)

    @classmethod
    def issue(cls, user, device: str = "") -> tuple["AuthToken", str]:
        raw = secrets.token_urlsafe(32)
        tok = cls.objects.create(user=user, key_hash=_hash(raw), prefix=raw[:8], device=device[:120],
                                 expires_at=dj_tz.now() + timedelta(days=settings.NATIVE_TOKEN_TTL_DAYS))
        return tok, raw

    @classmethod
    def lookup(cls, raw: str):
        return cls.objects.select_related("user").filter(key_hash=_hash(raw)).first()

    @property
    def valid(self) -> bool:
        return self.revoked_at is None and self.expires_at > dj_tz.now()


class TrustedDevice(models.Model):
    """An admin's browser that may skip the two-step code at sign-in for TRUST_DAYS (the password is still asked).

    The browser keeps a random token in an HttpOnly cookie; only its SHA-256 is stored. `marker` binds the trust to the
    current password and authenticator secret, so changing either (or resetting two-step verification) ends it.
    """

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="trusted_devices")
    token_hash = models.CharField(max_length=64, unique=True)
    marker = models.CharField(max_length=64)
    label = models.CharField(max_length=120, blank=True)  # browser and system, from the User-Agent
    created_at = models.DateTimeField(default=dj_tz.now)
    last_used_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=["user", "revoked_at"])]


class AdminProfile(models.Model):
    """Access of an admin account (see admin_access.py). `permissions` is only ever written through
    admin_access.validate(), so it holds known permission names only; owners need none (they hold all)."""

    class Level(models.TextChoices):
        OWNER = "owner", "المالك"
        ADMIN = "admin", "مسؤول"

    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="admin_profile")
    access_level = models.CharField(max_length=8, choices=Level.choices, default=Level.ADMIN)
    preset = models.CharField(max_length=24, default="custom")
    permissions = models.JSONField(default=list, blank=True)
    created_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(default=dj_tz.now)
    updated_at = models.DateTimeField(auto_now=True)

    def save(self, *args, **kwargs):
        from .admin_access import validate

        self.permissions = sorted(validate(self.permissions or []))  # never an unknown name
        super().save(*args, **kwargs)


class PhoneVerification(models.Model):
    """One code sent to a number (phones.py). Only an HMAC of the code is stored; used once; expires in 5 minutes."""

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="phone_verifications")
    phone_e164 = models.CharField(max_length=20)
    code_hash = models.CharField(max_length=64)
    created_at = models.DateTimeField(default=dj_tz.now)
    expires_at = models.DateTimeField()
    attempts = models.PositiveSmallIntegerField(default=0)
    consumed_at = models.DateTimeField(null=True, blank=True)
    outcome = models.CharField(max_length=24, blank=True)  # verified / replaced / too_many_attempts / send_failed

    class Meta:
        indexes = [models.Index(fields=["user", "created_at"]), models.Index(fields=["phone_e164", "created_at"])]
