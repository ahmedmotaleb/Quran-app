"""Multi-admin access (owner request, 23 October 2026).

Admin accounts keep `role = admin`; underneath, an AdminProfile gives an access level (owner or admin), the preset
the owner chose, and a validated permission set. Every admin endpoint declares what it needs and the server enforces
it (`IsAdminRole` reads the view's `admin_perm`); the portal only hides what the server would refuse anyway.

- Owner: every permission, including managing admins and security. There is always at least one active owner.
- Admin: exactly the permissions granted. An admin can never edit themselves, edit an owner, create an owner, or
  grant a permission they do not hold.
- An admin account without a profile has no permissions (deny by default).

Teacher + admin on one account (owner request, 24 October 2026): a teacher keeps `role = teacher` and gets an
AdminProfile. Admin access always comes from the profile (`has_admin_access`), never from the role:
- the admin portal's own session (signed in at the admin login, with two-step verification) is the admin context;
  the same person in the teacher app is a teacher and nothing more (`acts_as_admin`);
- `AdminProfile.is_active = False` («تعطيل صلاحيات الإدارة») stops admin access without touching the account;
- removing the profile («إزالة صلاحيات الإدارة») leaves the teacher account exactly as it was.
"""
from __future__ import annotations

from collections.abc import Callable

PERMISSIONS: dict[str, str] = {
    # People
    "users.view": "عرض الطلاب",
    "users.view_contact": "عرض البريد والهاتف كاملين",
    "users.create": "إضافة طلاب وأولياء أمور",
    "users.edit": "تعديل بيانات الحسابات",
    "users.suspend": "إيقاف وإعادة تفعيل الحسابات",
    "users.archive": "أرشفة الحسابات",
    "users.delete_permanent": "الحذف النهائي",
    "users.promote_teacher": "ترقية طالب إلى معلم",
    "teachers.view": "عرض المعلمين",
    "teachers.approve": "اعتماد المعلمين",
    "teachers.assign": "ربط الطلاب بالمعلمين",
    "parents.view": "عرض أولياء الأمور",
    "parents.link_child": "ربط أولياء الأمور بالأبناء",
    # Scheduling
    "bookings.view": "عرض الحجوزات",
    "bookings.manage": "إدارة الحجوزات",
    "sessions.view": "عرض الجلسات",
    "sessions.manage": "إدارة الجلسات",
    "circles.view": "عرض الحلقات",
    "circles.manage": "إدارة الحلقات",
    "attendance.manage": "إدارة الحضور والانضباط",
    "excuses.review": "مراجعة طلبات الاعتذار",
    # Learning
    "assignments.view": "عرض الواجبات",
    "assignments.manage": "إدارة الواجبات",
    "submissions.view": "الاستماع إلى تسجيلات الطلاب",
    "feedback.view": "عرض تقييمات المعلمين",
    # Content
    "courses.view": "عرض الدورات والمحتوى",
    "courses.manage": "إدارة الدورات والتسجيل فيها",
    "lessons.manage": "إدارة الدروس",
    "quizzes.manage": "إدارة الاختبارات والأسئلة",
    # Communication
    "notifications.send": "إرسال رسائل داخل التطبيق",
    "invitations.send": "إرسال الدعوات وروابط الإعداد",
    # Support
    "support.view": "عرض طلبات الدعم",
    "support.manage": "الرد على طلبات الدعم وإسنادها وتغيير حالتها",
    # Reports
    "analytics.view": "عرض التقارير",
    "exports.create": "تصدير القوائم",
    # System
    "settings.view": "عرض الإعدادات",
    "settings.manage": "تعديل الإعدادات",
    "audit.view": "عرض سجل التدقيق",
    "admins.manage": "إدارة المسؤولين والصلاحيات",
    "security.manage": "إعدادات الأمان",
}
ALL = frozenset(PERMISSIONS)

PRESET_LABELS = {
    "owner": "المالك", "academic_manager": "مدير أكاديمي", "support": "خدمة العملاء", "content": "إدارة المحتوى",
    "sessions": "مسؤول الجلسات", "read_only": "مشاهدة فقط", "custom": "صلاحيات مخصصة",
}
PRESETS: dict[str, frozenset[str]] = {
    "owner": ALL,
    "academic_manager": frozenset({
        "users.view", "users.view_contact", "users.create", "users.edit", "users.suspend", "users.archive",
        "teachers.view", "teachers.approve", "teachers.assign", "parents.view", "parents.link_child",
        "bookings.view", "bookings.manage", "sessions.view", "sessions.manage", "circles.view", "circles.manage",
        "attendance.manage", "excuses.review", "assignments.view", "assignments.manage", "submissions.view",
        "feedback.view", "courses.view", "courses.manage", "lessons.manage", "quizzes.manage", "notifications.send",
        "invitations.send", "analytics.view", "exports.create", "support.view", "support.manage"}),
    "support": frozenset({
        "users.view", "users.view_contact", "users.suspend", "parents.view", "parents.link_child", "teachers.view",
        "bookings.view", "invitations.send", "support.view", "support.manage"}),
    "content": frozenset({"courses.view", "courses.manage", "lessons.manage", "quizzes.manage"}),
    "sessions": frozenset({
        "sessions.view", "sessions.manage", "bookings.view", "bookings.manage", "circles.view", "circles.manage",
        "attendance.manage", "excuses.review", "users.view", "teachers.view"}),
    "read_only": frozenset({
        "users.view", "teachers.view", "parents.view", "bookings.view", "sessions.view", "circles.view",
        "courses.view", "analytics.view"}),
}


def validate(perms) -> frozenset[str]:
    """Only known permission names; anything else is refused (never stored)."""
    from apps.core.exceptions import ApiError

    if not isinstance(perms, (list, tuple, set, frozenset)) or not all(isinstance(p, str) for p in perms):
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"permissions": ["قائمة صلاحيات غير صالحة."]})
    unknown = sorted(set(perms) - ALL)
    if unknown:
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"permissions": [f"صلاحية غير معروفة: {unknown[0]}"]})
    return frozenset(perms)


def profile_of(user):
    return getattr(user, "admin_profile", None) if getattr(user, "is_authenticated", False) else None


def has_admin_access(user) -> bool:
    """May this account use the admin portal at all? An active account with an active AdminProfile (any role — a
    teacher keeps `role = teacher`), or a traditional admin account (`role = admin`) without a profile, which gets in
    with no permissions (deny by default), as before. Students and parents never have a profile."""
    from .models import Role

    if not getattr(user, "is_authenticated", False) or not user.is_active or not user.can_sign_in:
        return False
    prof = profile_of(user)
    if prof is not None:
        return bool(prof.is_active) and user.role in (Role.ADMIN, Role.TEACHER)
    return user.role == Role.ADMIN


def is_teacher_admin(user) -> bool:
    from .models import Role

    return getattr(user, "role", None) == Role.TEACHER and profile_of(user) is not None


def acts_as_admin(user) -> bool:
    """This request is made with admin authority: a traditional admin account, or a teacher + admin account signed in
    to the admin portal (its own session; set by AdminPortalSessionAuthentication). In the teacher app the same
    account is only a teacher."""
    from .models import Role

    return getattr(user, "role", None) == Role.ADMIN or bool(getattr(user, "_admin_ctx", False))


def admin_users():
    """Accounts that receive admin notices: traditional admins and teachers with active admin access."""
    from django.db.models import Q

    from .models import AccountStatus, Role, User

    return (User.objects.filter(status=AccountStatus.ACTIVE, is_active=True)
            .filter(Q(role=Role.ADMIN) & (Q(admin_profile__isnull=True) | Q(admin_profile__is_active=True))
                    | Q(role=Role.TEACHER, admin_profile__is_active=True)).distinct())


def perms_of(user) -> frozenset[str]:
    prof = profile_of(user)
    if prof is None or not prof.is_active:
        return frozenset()
    return ALL if prof.access_level == "owner" else frozenset(prof.permissions or ())


def mfa_required(user) -> bool:
    """Two-step verification before any admin page: where the deployment requires it (production), always for admins
    invited through the portal, and always for a teacher given admin access."""
    from django.conf import settings

    prof = profile_of(user)
    return bool(settings.ADMIN_REQUIRE_MFA or (prof is not None and prof.created_by_id is not None) or is_teacher_admin(user))


def access_out(user) -> dict | None:
    """What the portal needs to show only allowed modules (the server still checks every request). For a teacher
    with admin access the teacher app uses it to show «لوحة الإدارة»."""
    from .models import Role

    prof = profile_of(user)
    if user.role != Role.ADMIN and prof is None:
        return None
    return {"level": prof.access_level if prof else "", "preset": prof.preset if prof else "",
            "permissions": sorted(perms_of(user)), "active": bool(prof.is_active) if prof else True,
            "teacher_admin": is_teacher_admin(user)}


def holder_guard(actor, target, *, new_status: str | None = None) -> str | None:
    """Changes to the ACCOUNT of a teacher who also has admin access (suspend, archive, delete from the people pages):
    only someone who manages admins (and, for an owner, only another owner), never oneself, and never the last active
    owner. Returns the refusal message, or None."""
    if profile_of(target) is None:
        return None
    if target.pk == getattr(actor, "pk", None):
        return "لا يمكنك تغيير حالة حسابك بنفسك."
    if not has(actor, "admins.manage"):
        return "لهذا الحساب صلاحيات إدارة؛ يغيّر حالته من يملك صلاحية إدارة المسؤولين."
    if is_owner(target):
        if not is_owner(actor):
            return "إدارة حسابات المالكين متاحة للمالك فقط."
        from .models import AccountStatus, AdminProfile

        if new_status != AccountStatus.ACTIVE and not AdminProfile.objects.filter(
                access_level="owner", is_active=True, user__status=AccountStatus.ACTIVE, user__is_active=True).exclude(user=target).exists():
            return "يجب أن يبقى مالك نشط واحد على الأقل."
    return None


def is_owner(user) -> bool:
    prof = profile_of(user)
    return bool(prof and prof.is_active and prof.access_level == "owner")


def has(user, perm: str) -> bool:
    return perm in perms_of(user)


def require(user, perm: str) -> None:
    from apps.core.exceptions import ApiError

    if not has(user, perm):
        raise ApiError("admin_permission_denied", "ليست لديك صلاحية لهذا الإجراء.", 403, {"permission": [perm]})


# ---- what each request needs -------------------------------------------------------------------
ROLE_VIEW = {"student": "users.view", "teacher": "teachers.view", "parent": "parents.view"}


def people_view_perm(role: str | None) -> str:
    return ROLE_VIEW.get(role or "", "users.view")


def required(view, request) -> str | None:
    """The permission a view needs for this request: `admin_perm` is a name, {"read": ..., "write": ...} or a
    callable(view, request). `admin_any = True` marks endpoints every admin may use (own MFA, own devices,
    own saved views). None means the view declared nothing: refused."""
    spec = getattr(view, "admin_perm", None)
    if isinstance(spec, dict):
        spec = spec["read" if request.method in ("GET", "HEAD", "OPTIONS") else "write"]
    if callable(spec):
        spec = spec(view, request)
    return spec


def ensure_owner(user, by=None) -> None:
    """Ops paths (create_admin, promote_admin, the dev seed) create owners: full access, nothing to configure."""
    from .models import AdminProfile

    AdminProfile.objects.update_or_create(user=user, defaults={"access_level": "owner", "preset": "owner", "permissions": [],
                                                                "created_by": by})


# ---- bulk actions and exports (core/bulk.py) ---------------------------------------------------
BULK_READ = {"users": "users.view", "tests": "courses.view", "questions": "courses.view", "courses": "courses.view",
             "lessons": "courses.view", "enrollments": "courses.view", "circles": "circles.view", "bookings": "bookings.view",
             "sessions": "sessions.view"}
BULK_WRITE = {"tests": "quizzes.manage", "questions": "quizzes.manage", "courses": "courses.manage", "lessons": "lessons.manage",
              "enrollments": "courses.manage", "circles": "circles.manage", "bookings": "bookings.manage", "sessions": "sessions.manage"}
USER_ACTIONS = {"activate": "users.suspend", "suspend": "users.suspend", "archive": "users.archive", "delete": "users.delete_permanent",
                "approve": "teachers.approve", "unapprove": "teachers.approve", "assign_teacher": "teachers.assign",
                "enroll": "courses.manage", "notify": "notifications.send", "move_to_circle": "circles.manage",
                "resend_setup": "invitations.send"}
FRESH_MFA_ACTIONS = {("users", "delete")}  # irreversible: the admin confirms with a current authenticator code


def bulk_perm(resource: str, action: str | None) -> str | None:
    """None = not allowed for anyone (unknown resource or action)."""
    if action is None:
        return BULK_READ.get(resource)
    if resource == "users":
        return USER_ACTIONS.get(action)
    return BULK_WRITE.get(resource)


def require_fresh_mfa(request) -> None:
    """For the most sensitive actions (permanent delete, admin access changes): a current authenticator code in the
    request (`otp`), even inside a signed-in session. Admins without two-step verification are already blocked from
    the portal wherever it is required (deployed environments)."""
    from apps.core.exceptions import ApiError

    from . import totp

    u = request.user
    if not u.mfa_enabled:
        return
    code = str(request.data.get("otp", "") or "").strip()
    if not code:
        raise ApiError("fresh_mfa_required", "أدخل رمز التحقق الحالي من تطبيق المصادقة.", 403,
                       {"otp": ["أدخل رمز التحقق الحالي من تطبيق المصادقة."]})
    if not totp.verify(u.mfa_secret, code):
        raise ApiError("fresh_mfa_invalid", "رمز التحقق غير صحيح. أدخل الرمز الحالي وحاول مرة أخرى.", 403,
                       {"otp": ["رمز التحقق غير صحيح. أدخل الرمز الحالي وحاول مرة أخرى."]})


ANY = "__any__"
PermSpec = str | dict | Callable
