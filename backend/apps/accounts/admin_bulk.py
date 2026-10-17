"""Admin people lists: validated filters, sort and bulk actions (students, teachers, parents).

People are never deleted: their tasks, recordings metadata, feedback, attendance and audit history must stay. The
bulk actions are activate, suspend, archive (a soft delete: no sign-in, no password recovery, everything kept) and,
for teachers, approve / withdraw approval.
"""
from __future__ import annotations

from django.db.models import Exists, OuterRef, Q
from django.utils import timezone

from apps.core.bulk import Action, FilterSpec, Refuse, Resource, Skip, date_range, p_bool, p_choice, p_date, p_int, p_text, register, search_q

from .models import AccountStatus, AuthToken, GuardianLink, LinkStatus, Role, TeacherAssignment, TeacherProfile, User


def _apply(qs, f):
    if "role" in f:
        qs = qs.filter(role=f["role"])
    # Archived accounts only appear when asked for explicitly.
    qs = qs.filter(status=f["status"]) if "status" in f else qs.exclude(status=AccountStatus.ARCHIVED)
    if f.get("q"):
        qs = qs.filter(search_q(f["q"], ["full_name", "email", "phone"]))
    qs = date_range(qs, f, "date_joined", "joined_from", "joined_to")
    qs = date_range(qs, f, "last_login", "active_from", "active_to")
    now = timezone.now()
    if "approved" in f:
        ok = Q(teacher_profile__approved_at__isnull=False)
        qs = qs.filter(role=Role.TEACHER).filter(ok if f["approved"] else ~ok)
    if "has_students" in f:
        e = Exists(TeacherAssignment.objects.filter(teacher=OuterRef("pk"), active=True))
        qs = qs.filter(e if f["has_students"] else ~e)
    if "has_slots" in f:
        from apps.scheduling.models import SessionOccurrence

        e = Exists(SessionOccurrence.objects.filter(teacher=OuterRef("pk"), status=SessionOccurrence.Status.SCHEDULED, starts_at__gt=now))
        qs = qs.filter(e if f["has_slots"] else ~e)
    if "circle" in f:
        from apps.scheduling.models import Booking, Circle

        qs = qs.filter(Exists(Circle.objects.filter(pk=f["circle"], teacher=OuterRef("pk")))
                       | Exists(Booking.objects.filter(student=OuterRef("pk"), occurrence__circle_id=f["circle"], status=Booking.Status.CONFIRMED)))
    if "teacher" in f:
        qs = qs.filter(Exists(TeacherAssignment.objects.filter(student=OuterRef("pk"), teacher_id=f["teacher"], active=True)))
    if f.get("level"):
        qs = qs.filter(student_profile__level__iexact=f["level"])
    if "upcoming" in f:
        from apps.scheduling.models import Booking

        e = Exists(Booking.objects.filter(student=OuterRef("pk"), status=Booking.Status.CONFIRMED, occurrence__starts_at__gt=now))
        qs = qs.filter(e if f["upcoming"] else ~e)
    if "overdue_review" in f:
        from apps.learning.models import Assignment, AssignmentStatus

        e = Exists(Assignment.objects.filter(student=OuterRef("pk"), review_schedule__isnull=False, due_at__lt=now,
                                             status__in=[AssignmentStatus.NOT_STARTED, AssignmentStatus.IN_PROGRESS, AssignmentStatus.NEEDS_REPEAT]))
        qs = qs.filter(e if f["overdue_review"] else ~e)
    if "linked" in f:
        e = (Exists(GuardianLink.objects.filter(guardian=OuterRef("pk"), status=LinkStatus.ACTIVE))
             | Exists(GuardianLink.objects.filter(student=OuterRef("pk"), status=LinkStatus.ACTIVE)))
        qs = qs.filter(e if f["linked"] else ~e)
    if f.get("unlinked"):  # students without an active teacher (the sidebar badge)
        qs = qs.filter(role=Role.STUDENT).exclude(Exists(TeacherAssignment.objects.filter(student=OuterRef("pk"), active=True)))
    return qs


USER_FILTERS = FilterSpec(
    parsers={
        "role": p_choice(Role.STUDENT, Role.TEACHER, Role.PARENT), "status": p_choice(*AccountStatus.values), "q": p_text,
        "joined_from": p_date, "joined_to": p_date, "active_from": p_date, "active_to": p_date,
        "approved": p_bool, "has_students": p_bool, "has_slots": p_bool, "circle": p_int, "teacher": p_int, "level": p_text,
        "upcoming": p_bool, "overdue_review": p_bool, "linked": p_bool, "unlinked": p_bool,
    },
    apply=_apply,
    sorts={"name": ("full_name",), "email": ("email",), "joined": ("date_joined",), "last_login": ("last_login",), "status": ("status",)},
    default_sort="-joined",
)


def _base():
    return User.objects.exclude(role=Role.ADMIN)  # admins are never targets of bulk actions


def _set_status(new: str):
    def run(u: User, actor, reason: str):
        if u.status == new:
            raise Skip("unchanged", "في هذه الحالة بالفعل.")
        if new == AccountStatus.SUSPENDED and u.status == AccountStatus.ARCHIVED:
            raise Refuse("archived", "الحساب مؤرشف؛ أعد تفعيله أولًا.")
        u.status = new
        u.save(update_fields=["status"])
        if new in (AccountStatus.SUSPENDED, AccountStatus.ARCHIVED):
            AuthToken.objects.filter(user=u, revoked_at__isnull=True).update(revoked_at=timezone.now())
    return run


def _approve(on: bool):
    def run(u: User, actor, reason: str):
        if u.role != Role.TEACHER:
            raise Refuse("not_teacher", "ليس حساب معلم.")
        prof, _ = TeacherProfile.objects.get_or_create(user=u)
        if bool(prof.approved_at) == on:
            raise Skip("unchanged", "معتمد بالفعل." if on else "غير معتمد بالفعل.")
        prof.approved_at = timezone.now() if on else None
        prof.save(update_fields=["approved_at"])
        if on and u.status == AccountStatus.PENDING:
            u.status = AccountStatus.ACTIVE
            u.save(update_fields=["status"])
    return run


register(Resource(
    name="users", label="accounts.user", base=_base, filters=USER_FILTERS, describe=lambda u: u.full_name,
    actions={
        "activate": Action(_set_status(AccountStatus.ACTIVE)),
        "suspend": Action(_set_status(AccountStatus.SUSPENDED), reason_required=True),
        "archive": Action(_set_status(AccountStatus.ARCHIVED), reason_required=True, destructive=True),
        "approve": Action(_approve(True)),
        "unapprove": Action(_approve(False), reason_required=True),
    },
))
