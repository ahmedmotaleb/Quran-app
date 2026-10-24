"""Multi-admin access (owner request, 23 October 2026).

Admin accounts keep `role = admin`; underneath, an AdminProfile gives an access level (owner or admin), the preset
the owner chose, and a validated permission set. Every admin endpoint declares what it needs and the server enforces
it (`IsAdminRole` reads the view's `admin_perm`); the portal only hides what the server would refuse anyway.

- Owner: every permission, including managing admins and security. There is always at least one active owner.
- Admin: exactly the permissions granted. An admin can never edit themselves, edit an owner, create an owner, or
  grant a permission they do not hold.
- An admin account without a profile has no permissions (deny by default).
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


def perms_of(user) -> frozenset[str]:
    from .models import Role

    if not getattr(user, "is_authenticated", False) or user.role != Role.ADMIN:
        return frozenset()
    prof = getattr(user, "admin_profile", None)
    if prof is None:
        return frozenset()
    return ALL if prof.access_level == "owner" else frozenset(prof.permissions or ())


def mfa_required(user) -> bool:
    """Two-step verification before any admin page: where the deployment requires it (production), and always for
    admins invited through the portal."""
    from django.conf import settings

    prof = getattr(user, "admin_profile", None)
    return bool(settings.ADMIN_REQUIRE_MFA or (prof is not None and prof.created_by_id is not None))


def access_out(user) -> dict | None:
    """What the portal needs to show only allowed modules (the server still checks every request)."""
    from .models import Role

    if user.role != Role.ADMIN:
        return None
    prof = getattr(user, "admin_profile", None)
    return {"level": prof.access_level if prof else "", "preset": prof.preset if prof else "",
            "permissions": sorted(perms_of(user))}


def is_owner(user) -> bool:
    prof = getattr(user, "admin_profile", None)
    return bool(prof and prof.access_level == "owner")


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
