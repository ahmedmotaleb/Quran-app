"""Admin people lists: validated filters, sort and bulk actions (students, teachers, parents).

The bulk actions include activate, suspend, archive (a soft delete: no sign-in, no password recovery, everything kept,
reversible), delete (permanent: personal data erased, educational records kept anonymous; see erase.py) and, for
teachers, approve / withdraw approval. Deleted accounts never appear in these lists.
"""
from __future__ import annotations

from django.db.models import Exists, OuterRef, Q
from django.utils import timezone

from apps.core.bulk import Action, FilterSpec, Refuse, Resource, Skip, date_range, p_bool, p_choice, p_date, p_int, p_text, register, search_q
from apps.core.exceptions import ApiError

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
        from apps.scheduling.models import Booking, Circle, CircleMember

        qs = qs.filter(Exists(Circle.objects.filter(pk=f["circle"], teacher=OuterRef("pk")))
                       | Exists(CircleMember.objects.filter(student=OuterRef("pk"), circle_id=f["circle"], active=True))
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
    if "course" in f:  # a course cohort: students actively enrolled
        from apps.learning.models import Enrollment

        qs = qs.filter(Exists(Enrollment.objects.filter(student=OuterRef("pk"), course_id=f["course"], status=Enrollment.Status.ACTIVE)))
    if f.get("unlinked"):  # students without an active teacher (the sidebar badge)
        qs = qs.filter(role=Role.STUDENT).exclude(Exists(TeacherAssignment.objects.filter(student=OuterRef("pk"), active=True)))
    return qs


USER_FILTERS = FilterSpec(
    parsers={
        "role": p_choice(Role.STUDENT, Role.TEACHER, Role.PARENT), "status": p_choice(*[x for x in AccountStatus.values if x != AccountStatus.DELETED]), "q": p_text,
        "joined_from": p_date, "joined_to": p_date, "active_from": p_date, "active_to": p_date,
        "approved": p_bool, "has_students": p_bool, "has_slots": p_bool, "circle": p_int, "teacher": p_int, "level": p_text,
        "upcoming": p_bool, "overdue_review": p_bool, "linked": p_bool, "unlinked": p_bool, "course": p_int,
    },
    apply=_apply,
    sorts={"name": ("full_name",), "email": ("email",), "joined": ("date_joined",), "last_login": ("last_login",), "status": ("status",)},
    default_sort="-joined",
)


def _base():
    # Admins are never targets of bulk actions; deleted accounts are gone from the admin's view.
    return User.objects.exclude(role=Role.ADMIN).exclude(status=AccountStatus.DELETED)


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


def _bad(field: str, msg: str):
    return ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {field: [msg]})


# ---- Assign a teacher ----------------------------------------------------------------------
def _teacher_params(raw: dict, actor) -> dict:
    t = User.objects.filter(pk=raw.get("teacher") if str(raw.get("teacher", "")).isdigit() else None, role=Role.TEACHER).first()
    if t is None:
        raise _bad("teacher", "اختر معلمًا.")
    if t.status != AccountStatus.ACTIVE or not TeacherProfile.objects.filter(user=t, approved_at__isnull=False).exists():
        raise _bad("teacher", "المعلم غير معتمد أو غير نشط.")
    return {"teacher": t, "replace": raw.get("replace") is True}


def _assign_teacher(u: User, actor, reason: str, *, teacher: User, replace: bool):
    if u.role != Role.STUDENT:
        raise Refuse("not_student", "ليس حساب طالب.")
    if u.status in (AccountStatus.SUSPENDED, AccountStatus.ARCHIVED):
        raise Refuse("inactive", "الحساب موقوف أو مؤرشف.")
    current = TeacherAssignment.objects.select_for_update().filter(student=u, active=True)
    ended = current.exclude(teacher=teacher).update(active=False, ended_at=timezone.now()) if replace else 0
    if current.filter(teacher=teacher).exists():
        if ended:
            return  # the other teachers were removed; the requested one stays
        raise Skip("already_assigned", "مرتبط بهذا المعلم بالفعل.")
    TeacherAssignment.objects.create(teacher=teacher, student=u, created_by=actor)


# ---- Enroll in a course ---------------------------------------------------------------------
def _course_params(raw: dict, actor) -> dict:
    from apps.learning.models import Course, PublishState

    c = Course.objects.filter(pk=raw.get("course") if str(raw.get("course", "")).isdigit() else None).first()
    if c is None:
        raise _bad("course", "اختر دورة.")
    if c.state == PublishState.ARCHIVED:
        raise _bad("course", "لا يمكن التسجيل في دورة مؤرشفة.")
    return {"course": c}


def _enroll(u: User, actor, reason: str, *, course):
    from apps.learning.models import Enrollment

    if u.role != Role.STUDENT:
        raise Refuse("not_student", "ليس حساب طالب.")
    if u.status in (AccountStatus.SUSPENDED, AccountStatus.ARCHIVED):
        raise Refuse("inactive", "الحساب موقوف أو مؤرشف.")
    if Enrollment.objects.filter(course=course, student=u, status=Enrollment.Status.ACTIVE).exists():
        raise Skip("already_enrolled", "مسجّل في هذه الدورة بالفعل.")
    Enrollment.objects.create(course=course, student=u, created_by=actor, starts_on=timezone.localdate())


# ---- Move to a circle -------------------------------------------------------------------------
def _circle_params(raw: dict, actor) -> dict:
    from apps.scheduling.models import Circle

    c = Circle.objects.select_related("teacher").filter(pk=raw.get("circle") if str(raw.get("circle", "")).isdigit() else None).first()
    if c is None:
        raise _bad("circle", "اختر حلقة.")
    if c.state != Circle.State.PUBLISHED:
        raise _bad("circle", "الحلقة غير منشورة.")
    return {"circle": c}


def _move_to_circle(u: User, actor, reason: str, *, circle):
    from apps.scheduling import membership
    from apps.scheduling.models import CircleMember

    if u.role != Role.STUDENT:
        raise Refuse("not_student", "ليس حساب طالب.")
    if CircleMember.objects.filter(circle=circle, student=u, active=True).exists():
        raise Skip("already_member", "عضو في هذه الحلقة بالفعل.")
    try:
        membership.join(circle, u, actor)  # checks capacity under a lock on the circle
    except membership.MembershipError as e:
        raise Refuse(e.code, str(e.detail)) from None
    for old in CircleMember.objects.filter(student=u, active=True).exclude(circle=circle).select_related("circle", "student"):
        membership.leave(old, actor, reason or f"نُقل إلى {circle.name}")


# ---- In-app message --------------------------------------------------------------------------
def _message_params(raw: dict, actor) -> dict:
    import uuid

    title = str(raw.get("title", "")).strip()
    body = str(raw.get("body", "")).strip()
    if not 3 <= len(title) <= 80:
        raise _bad("title", "العنوان من 3 إلى 80 حرفًا.")
    if not 3 <= len(body) <= 500:
        raise _bad("body", "نص الرسالة من 3 إلى 500 حرف.")
    return {"title": title, "body": body, "batch": uuid.uuid4().hex[:12]}


def _notify(u: User, actor, reason: str, *, title: str, body: str, batch: str):
    from apps.notifications.services import after_commit

    if u.status in (AccountStatus.SUSPENDED, AccountStatus.ARCHIVED):
        raise Refuse("inactive", "الحساب موقوف أو مؤرشف.")
    # Kind `admin_message`: the phone's lock screen shows only the generic text, never this message.
    after_commit(u, "admin_message", title, body, link="/inbox", dedupe=f"admin_message:{batch}:{u.pk}", data={"batch": batch})


# ---- Resend the password-setup email ------------------------------------------------------------
RESEND_EVERY_MINUTES = 10


def _resend_params(raw: dict, actor) -> dict:
    from .views import email_configured

    if not email_configured():
        raise ApiError("email_off", "إرسال البريد غير مُعدّ؛ أنشئ رابط الإعداد من صفحة الحساب وسلّمه يدويًا.", 409)
    return {}


def _resend_setup(u: User, actor, reason: str):
    from datetime import timedelta

    from django.conf import settings
    from django.core.mail import send_mail

    from apps.core.audit import audit
    from apps.core.models import AuditEvent

    from .views import password_link

    if u.status in (AccountStatus.SUSPENDED, AccountStatus.ARCHIVED):
        raise Refuse("inactive", "الحساب موقوف أو مؤرشف.")
    if u.has_usable_password():
        raise Skip("has_password", "عيّن كلمة المرور بالفعل.")
    since = timezone.now() - timedelta(minutes=RESEND_EVERY_MINUTES)
    if AuditEvent.objects.filter(action="admin.setup_link_issued", target_type="accounts.user", target_id=str(u.pk), created_at__gte=since).exists():
        raise Skip("recently_sent", f"أُرسل رابط خلال آخر {RESEND_EVERY_MINUTES} دقائق.")
    # The link is emailed only; it is never returned to the browser or written to the audit log.
    if send_mail("مرحبًا بك في الحلقة", f"أنشئ كلمة مرور لحسابك من الرابط:\n{password_link(u)}", settings.DEFAULT_FROM_EMAIL, [u.email]) != 1:
        raise Refuse("email_failed", "تعذّر إرسال البريد.")
    audit("admin.setup_link_issued", actor=actor, target=u, emailed=True, bulk=True)


def _delete(u: User, actor, reason: str):
    from .erase import EraseRefused, erase_user

    try:
        erase_user(u, actor)
    except EraseRefused as e:
        raise Refuse(e.code, e.message) from None


def _teachers_of(u: User) -> str:
    return "، ".join(a.teacher.full_name for a in u.teacher_assignments.filter(active=True).select_related("teacher"))


register(Resource(
    name="users", label="accounts.user", base=_base, filters=USER_FILTERS, describe=lambda u: u.full_name,
    actions={
        "activate": Action(_set_status(AccountStatus.ACTIVE)),
        "suspend": Action(_set_status(AccountStatus.SUSPENDED), reason_required=True),
        "archive": Action(_set_status(AccountStatus.ARCHIVED), reason_required=True, destructive=True),
        "delete": Action(_delete, reason_required=True, destructive=True, confirm_always=True),
        "approve": Action(_approve(True)),
        "unapprove": Action(_approve(False), reason_required=True),
        "assign_teacher": Action(_assign_teacher, params=_teacher_params, audit_keys=("teacher", "replace")),
        "enroll": Action(_enroll, params=_course_params, audit_keys=("course",)),
        "notify": Action(_notify, params=_message_params, audit_keys=("title", "batch")),
        "move_to_circle": Action(_move_to_circle, params=_circle_params, audit_keys=("circle",)),
        "resend_setup": Action(_resend_setup, params=_resend_params),
    },
    export=[
        ("الرقم", lambda u: u.pk), ("الاسم", lambda u: u.full_name), ("البريد", lambda u: u.email), ("الهاتف", lambda u: u.phone),
        ("النوع", lambda u: Role(u.role).label), ("الحالة", lambda u: AccountStatus(u.status).label),
        ("المستوى", lambda u: getattr(getattr(u, "student_profile", None), "level", "") if u.role == Role.STUDENT else ""),
        ("المعلمون", lambda u: _teachers_of(u) if u.role == Role.STUDENT else ""),
        ("تاريخ الانضمام", lambda u: u.date_joined), ("آخر دخول", lambda u: u.last_login),
    ],
))
