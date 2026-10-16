"""
Role checks and object scoping. Every list/detail endpoint filters by these helpers, so changing
an id in a request cannot reveal another learner's data (OWASP: check role *and* ownership).
"""
from django.conf import settings
from django.db.models import Q, QuerySet
from rest_framework.permissions import BasePermission

from .models import GuardianLink, LinkStatus, Role, TeacherAssignment, User


class HasRole(BasePermission):
    roles: tuple[str, ...] = ()

    def has_permission(self, request, view):
        u = request.user
        return bool(u and u.is_authenticated and u.can_sign_in and u.role in self.roles)


class IsStudent(HasRole):
    roles = (Role.STUDENT,)


class IsTeacher(HasRole):
    roles = (Role.TEACHER,)


class IsParent(HasRole):
    roles = (Role.PARENT,)


class IsAdminRole(HasRole):
    """Admin APIs. With ADMIN_REQUIRE_MFA (on when deployed) an admin must first turn on two-step verification;
    only views marked `mfa_setup_view = True` (MFA setup/confirm) are reachable before that."""

    roles = (Role.ADMIN,)

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        if settings.ADMIN_REQUIRE_MFA and not request.user.mfa_enabled and not getattr(view, "mfa_setup_view", False):
            from apps.core.exceptions import ApiError

            raise ApiError("mfa_setup_required", "فعّل التحقق بخطوتين أولًا لاستخدام بوابة الإدارة.", 403)
        return True


class IsContentAuthor(HasRole):
    """Admins, and teachers for their own draft content."""

    roles = (Role.ADMIN, Role.TEACHER)


class IsLearningUser(HasRole):
    """Anyone who uses the learning app (not the admin portal)."""

    roles = (Role.STUDENT, Role.TEACHER, Role.PARENT)


def assigned_student_ids(teacher: User) -> QuerySet:
    return TeacherAssignment.objects.filter(teacher=teacher, active=True).values("student_id")


def linked_child_ids(parent: User) -> QuerySet:
    return GuardianLink.objects.filter(guardian=parent, status=LinkStatus.ACTIVE).values("student_id")


def visible_student_ids(user: User):
    """Students whose learning records this user may read. None = all (admin)."""
    if user.role == Role.ADMIN:
        return None
    if user.role == Role.STUDENT:
        return [user.pk]
    if user.role == Role.TEACHER:
        return assigned_student_ids(user)
    if user.role == Role.PARENT:
        return linked_child_ids(user)
    return []


def scope_by_student(qs: QuerySet, user: User, field: str = "student") -> QuerySet:
    ids = visible_student_ids(user)
    if ids is None:
        return qs
    q = Q(**{f"{field}_id__in": ids})
    # Teachers also see records they own as the responsible teacher (e.g. their own assignments).
    if user.role == Role.TEACHER and "teacher" in {f.name for f in qs.model._meta.get_fields()}:
        q |= Q(teacher=user)
    return qs.filter(q)


def can_view_student(user: User, student: User) -> bool:
    ids = visible_student_ids(user)
    if ids is None:
        return True
    if isinstance(ids, list):
        return student.pk in ids
    return ids.filter(student_id=student.pk).exists()
