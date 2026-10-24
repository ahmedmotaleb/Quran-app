"""Permanent account deletion (owner decision 22 October 2026: «حذف نهائي», erase personal data).

- An account with no activity is removed completely.
- An account with history (tasks, recordings, feedback, attendance, bookings, corrections, tests...) keeps those records
  so teacher history and statistics stay correct, but the person is erased: name «حساب محذوف», a placeholder email,
  no phone, no password, no MFA, profile details cleared, recordings and voice notes removed from storage, tokens,
  notifications, push subscriptions, bookmarks and saved views deleted, active links, memberships and future bookings
  ended. The account can never sign in again and cannot be reactivated.
- Admin accounts are never deleted here. A teacher with upcoming sessions is refused unless the admin chose to cancel
  them (`cancel_sessions`): each session and its bookings are cancelled and the students notified; past sessions stay.
- All-or-nothing (24 Oct fix): every database change happens in one transaction and the private files are removed from
  storage as its LAST step, in one batch request. If storage fails, the transaction rolls back, so the account is
  never left half-deleted (deleted identity with audio left behind, or audio gone with the account still active).
- Audit: `admin.user_deleted` with the id, role, mode and number of recordings removed — no name, email or file keys.
"""
from __future__ import annotations

import logging
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

log = logging.getLogger(__name__)
DELETED_NAME = "حساب محذوف"


class EraseRefused(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def is_deleted(u: User) -> bool:
    return u.status == AccountStatus.DELETED


UPCOMING_MSG = "لا يمكن حذف هذا المعلم قبل معالجة جلساته القادمة."
STORAGE_MSG = "تعذر حذف الملفات الصوتية المرتبطة بالحساب. لم يتم حذف الحساب. حاول مرة أخرى."


def _upcoming(u: User):
    from apps.scheduling.models import SessionOccurrence

    return SessionOccurrence.objects.filter(teacher=u, status=SessionOccurrence.Status.SCHEDULED, starts_at__gt=timezone.now())


def _check(u: User) -> None:
    if u.role == Role.ADMIN:
        raise EraseRefused("admin", "لا يمكن حذف حساب مدير.")
    if is_deleted(u):
        raise EraseRefused("already_deleted", "محذوف بالفعل.")
    n = _upcoming(u).count()
    if n:
        raise EraseRefused("upcoming_sessions", f"{UPCOMING_MSG} لديه {n} جلسة قادمة.")


def _has_history(u: User) -> bool:
    """True when deleting the row is refused by protected records (so the account will be anonymized)."""
    from django.db.models.deletion import Collector, RestrictedError

    try:
        Collector(using="default").collect([u])
    except (ProtectedError, RestrictedError):
        return True
    return False


def preflight(u: User) -> dict:
    """What a permanent delete would do, for the confirmation step (no change is made)."""
    from apps.media.models import MediaObject
    from apps.scheduling.models import Booking

    up = _upcoming(u)
    return {"id": u.pk, "role": u.role, "deletable": u.role != Role.ADMIN and not is_deleted(u),
            "upcoming_sessions": up.count(),
            "upcoming_bookings": Booking.objects.filter(occurrence__in=up, status=Booking.Status.CONFIRMED).count(),
            "mode": "anonymized" if _has_history(u) else "removed",
            "recordings": MediaObject.objects.filter(owner=u, purpose__in=MediaObject.PRIVATE_PURPOSES)
            .exclude(state=MediaObject.State.DELETED).count()}


def _cancel_upcoming(u: User, actor) -> int:
    """Cancel the teacher's future sessions and their bookings (students are notified after commit). Past sessions,
    attendance and history are untouched."""
    from apps.scheduling.services import cancel_occurrence

    n = 0
    for pk in _upcoming(u).values_list("pk", flat=True):
        cancel_occurrence(occurrence_id=pk, by=actor, reason="أُلغيت الجلسة لحذف حساب المعلم")
        n += 1
    return n


def _remove_media(u: User) -> list[str]:
    """Mark the person's recordings, voice notes and support screenshots deleted (the rows stay because submissions
    and feedback point at them) and return their storage keys. The files themselves are removed by erase_user as the
    last step of the transaction."""
    from apps.media.models import MediaObject

    qs = MediaObject.objects.filter(owner=u, purpose__in=MediaObject.PRIVATE_PURPOSES).exclude(state=MediaObject.State.DELETED)
    keys = list(qs.values_list("key", flat=True))
    qs.update(state=MediaObject.State.DELETED)
    return keys


def _anonymize(u: User, actor) -> list[str]:
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
    # Support tickets stay for the record, but what the person wrote is removed (their screenshots went above).
    from apps.support.models import Ticket, TicketMessage

    TicketMessage.objects.filter(author=u).update(body="(حُذف مع الحساب)")
    Ticket.objects.filter(requester=u).update(subject="(حُذف مع الحساب)", updated_at=now)
    Ticket.objects.filter(requester=u).exclude(status=Ticket.Status.CLOSED).update(status=Ticket.Status.CLOSED, closed_at=now)
    return media


def erase_user(u: User, actor, request=None, *, cancel_sessions: bool = False) -> str:
    """Delete one account. Returns "removed" (no activity, row gone) or "anonymized". Raises EraseRefused (nothing
    changed) — including when storage cannot delete the private files."""
    from django.db.models.deletion import RestrictedError

    from apps.media.storage import StorageError, get_storage

    pk, role = u.pk, u.role
    with transaction.atomic():
        sessions = _cancel_upcoming(u, actor) if cancel_sessions and u.role == Role.TEACHER else 0
        _check(u)
        try:
            with transaction.atomic():
                u.delete()  # refused (ProtectedError) as soon as the person has any educational history
            mode, keys = "removed", []
        except (ProtectedError, RestrictedError):
            mode, keys = "anonymized", _anonymize(u, actor)
        audit("admin.user_deleted", actor=actor, target=SimpleNamespace(_meta=User._meta, pk=pk), request=request,
              role=role, mode=mode, recordings_removed=len(keys), **({"sessions_cancelled": sessions} if sessions else {}))
        if keys:
            try:
                get_storage().delete_many(keys)  # last: a failure here rolls back every change above
            except StorageError as e:
                log.warning("user_delete_storage_failed", extra={"user": pk, "category": e.category, "files": len(keys)})
                raise EraseRefused("storage_failed", STORAGE_MSG) from None
    return mode
