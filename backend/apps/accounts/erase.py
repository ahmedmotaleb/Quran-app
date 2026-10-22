"""Permanent account deletion (owner decision 22 October 2026: «حذف نهائي», erase personal data).

- An account with no activity is removed completely.
- An account with history (tasks, recordings, feedback, attendance, bookings, corrections, tests...) keeps those records
  so teacher history and statistics stay correct, but the person is erased: name «حساب محذوف», a placeholder email,
  no phone, no password, no MFA, profile details cleared, recordings and voice notes removed from storage, tokens,
  notifications, push subscriptions, bookmarks and saved views deleted, active links, memberships and future bookings
  ended. The account can never sign in again and cannot be reactivated.
- Admin accounts are never deleted here. A teacher with upcoming sessions must have them cancelled or moved first.
- Audit: `admin.user_deleted` with the id, role and mode only — no name or email.
"""
from __future__ import annotations

from types import SimpleNamespace

from django.db import transaction
from django.db.models import ProtectedError
from django.utils import timezone

from apps.core.audit import audit

from .models import (
    AccountStatus,
    AuthToken,
    GuardianLink,
    Invitation,
    LinkStatus,
    Role,
    TeacherAssignment,
    User,
)

DELETED_NAME = "حساب محذوف"


class EraseRefused(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def is_deleted(u: User) -> bool:
    return u.status == AccountStatus.DELETED


def _check(u: User) -> None:
    from apps.scheduling.models import SessionOccurrence

    if u.role == Role.ADMIN:
        raise EraseRefused("admin", "لا يمكن حذف حساب مدير.")
    if is_deleted(u):
        raise EraseRefused("already_deleted", "محذوف بالفعل.")
    if SessionOccurrence.objects.filter(teacher=u, status=SessionOccurrence.Status.SCHEDULED, starts_at__gt=timezone.now()).exists():
        raise EraseRefused("upcoming_sessions", "للمعلم جلسات قادمة؛ ألغِها أو انقلها إلى معلم آخر أولًا.")


def _remove_media(u: User) -> int:
    """Delete the person's recordings and voice notes from storage; the rows stay (marked deleted) because submissions
    and feedback point at them. Deleting a missing object succeeds, so a retry after a storage error is safe."""
    from apps.media.models import MediaObject
    from apps.media.storage import get_storage

    n = 0
    qs = MediaObject.objects.filter(owner=u, purpose__in=MediaObject.PRIVATE_PURPOSES).exclude(state=MediaObject.State.DELETED)
    for m in qs:
        get_storage().delete(m.key)
        m.state = MediaObject.State.DELETED
        m.save(update_fields=["state", "updated_at"])
        n += 1
    return n


def _anonymize(u: User, actor) -> int:
    from apps.core.models import SavedView
    from apps.notifications.models import Notification, PushSubscription
    from apps.quran.models import Bookmark, ReadingPosition
    from apps.scheduling.models import (
        AvailabilityException,
        AvailabilityRule,
        Booking,
        CircleMember,
    )

    now = timezone.now()
    media = _remove_media(u)
    u.full_name, u.email, u.phone = DELETED_NAME, f"deleted-{u.pk}@deleted.invalid", ""
    u.status, u.is_active, u.is_staff = AccountStatus.DELETED, False, False
    u.mfa_secret, u.mfa_enabled = "", False
    u.set_unusable_password()  # also invalidates any browser session (the session hash changes)
    u.save()
    if hasattr(u, "student_profile"):
        u.student_profile.delete()
    if hasattr(u, "teacher_profile"):
        p = u.teacher_profile
        p.specialization = p.bio = p.audience = p.levels = ""
        p.tags, p.offers_individual, p.offers_group = [], False, False
        p.save()
    AuthToken.objects.filter(user=u).delete()
    for model, field in ((Notification, "recipient"), (PushSubscription, "user"), (Bookmark, "user"),
                         (ReadingPosition, "user"), (SavedView, "owner"), (AvailabilityRule, "teacher"),
                         (AvailabilityException, "teacher")):
        model.objects.filter(**{field: u}).delete()
    TeacherAssignment.objects.filter(active=True).filter(teacher=u).update(active=False, ended_at=now)
    TeacherAssignment.objects.filter(active=True).filter(student=u).update(active=False, ended_at=now)
    GuardianLink.objects.filter(status=LinkStatus.ACTIVE, guardian=u).update(status=LinkStatus.REVOKED, updated_at=now)
    GuardianLink.objects.filter(status=LinkStatus.ACTIVE, student=u).update(status=LinkStatus.REVOKED, updated_at=now)
    CircleMember.objects.filter(student=u, active=True).update(active=False, ended_at=now, ended_by=actor,
                                                               end_reason="حُذف الحساب", updated_at=now)
    Booking.objects.filter(student=u, status=Booking.Status.CONFIRMED, occurrence__starts_at__gt=now).update(
        status=Booking.Status.CANCELLED, cancelled_at=now, cancelled_by=actor, cancel_reason="حُذف الحساب", updated_at=now)
    Invitation.objects.filter(created_by=u, revoked_at__isnull=True, uses=0).update(
        revoked_at=now, revoke_reason="revoked", updated_at=now)
    return media


def erase_user(u: User, actor, request=None) -> str:
    """Delete one account. Returns "removed" (no activity, row gone) or "anonymized". Raises EraseRefused."""
    _check(u)
    pk, role = u.pk, u.role
    with transaction.atomic():
        try:
            with transaction.atomic():
                u.delete()  # refused (ProtectedError) as soon as the person has any educational history
            mode, media = "removed", 0
        except ProtectedError:
            mode, media = "anonymized", _anonymize(u, actor)
        audit("admin.user_deleted", actor=actor, target=SimpleNamespace(_meta=User._meta, pk=pk), request=request,
              role=role, mode=mode, recordings_removed=media)
    return mode
