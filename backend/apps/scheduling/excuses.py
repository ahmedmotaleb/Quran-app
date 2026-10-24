"""Excuses and the absence discipline rule (owner decision 23 October 2026).

    الطالب لا يلغي الجلسة — يطلب اعتذارًا، والمعلم يعتمد العذر. بعد 3 غيابات بدون عذر مقبول، يُوقف الحساب تلقائيًا.

- A student never cancels a booking; they send one excuse per booking, up to `excuse_deadline_minutes` before it starts.
- The session's teacher approves (response optional) or rejects (response required). An admin may approve through an
  audited correction; the teacher's decision stays recorded beside it.
- The booking is never cancelled by an excuse. Approval records the attendance as «غاب بعذر» (excused).
- Unexcused absences are derived, never stored: confirmed bookings marked absent whose excuse is not approved and not
  pending. A pending excuse holds the count until it is decided.
- 1 → warning, 2 → final warning, 3 → the student is suspended (once; idempotent under a row lock on the student).
- Correction policy (pilot): if a later correction drops an automatically suspended student below 3, the account is
  NOT reactivated automatically; admins get an alert and decide (audit `student.absence_suspension_review`).
- Reactivation never resets the history; only a new unexcused absence can suspend again.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from apps.accounts.models import AccountStatus, AuthToken, GuardianLink, LinkStatus, Role, User
from apps.core.audit import audit
from apps.core.exceptions import ApiError
from apps.core.models import AppSettings

from .models import Booking, BookingExcuse, SessionOccurrence

LIMIT = 3  # the 3rd unexcused absence suspends the account
AUTO_REASON = "تجاوز الحد المسموح للغياب بدون عذر (3 غيابات)"
E = BookingExcuse.Status
NOT_FOUND = ApiError("not_found", "العنصر المطلوب غير موجود.", 404)


# ---- counting (source of truth: attendance + excuses) ---------------------------------------
def unexcused_q() -> Q:
    """Bookings that count: confirmed, marked absent, and no approved or pending excuse."""
    return (Q(status=Booking.Status.CONFIRMED, attendance=Booking.Attendance.ABSENT)
            & ~Q(excuse__status__in=[E.APPROVED, E.PENDING]))


def unexcused_count(student) -> int:
    return Booking.objects.filter(unexcused_q(), student=student).count()


def summary(student) -> dict:
    """Attendance and discipline figures for one student (admin view)."""
    qs = Booking.objects.filter(student=student, status=Booking.Status.CONFIRMED)
    now = timezone.now()
    ex = BookingExcuse.objects.filter(student=student)
    n = unexcused_count(student)
    return {
        "total_sessions": qs.filter(occurrence__starts_at__lte=now).exclude(occurrence__status=SessionOccurrence.Status.CANCELLED).count(),
        "present": qs.filter(attendance=Booking.Attendance.PRESENT).count(),
        "late": qs.filter(attendance=Booking.Attendance.LATE).count(),
        "excused": qs.filter(attendance=Booking.Attendance.EXCUSED).count(),
        "approved_excuses": ex.filter(status=E.APPROVED).count(),
        "pending_excuses": ex.filter(status=E.PENDING).count(),
        "rejected_excuses": ex.filter(status=E.REJECTED).count(),
        "unexcused_absences": n, "limit": LIMIT - 1, "suspends_at": LIMIT,
        "suspended": student.status == AccountStatus.SUSPENDED, "status_reason": student.status_reason,
    }


# ---- the student's request ----------------------------------------------------------------
def deadline(b: Booking) -> datetime:
    return b.occurrence.starts_at - timedelta(minutes=AppSettings.load().excuse_deadline_minutes)


def request_excuse(*, booking_id: int, student, reason: str, request=None) -> tuple[BookingExcuse, bool]:
    reason = (reason or "").strip()
    if not 5 <= len(reason) <= 500:
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"reason": ["اكتب سبب الاعتذار (من 5 إلى 500 حرف)."]})
    with transaction.atomic():
        b = Booking.objects.select_for_update().select_related("occurrence").filter(pk=booking_id, student=student).first()
        if b is None:
            raise NOT_FOUND
        existing = BookingExcuse.objects.filter(booking=b).first()
        if existing:
            if existing.status == E.PENDING and existing.reason == reason:
                return existing, False  # the same request sent twice
            raise ApiError("excuse_exists", "أرسلت اعتذارًا عن هذه الجلسة بالفعل.", 409)
        if b.status != Booking.Status.CONFIRMED or b.occurrence.status == SessionOccurrence.Status.CANCELLED:
            raise ApiError("not_active", "هذا الحجز غير نشط.", 409)
        if timezone.now() > deadline(b):
            raise ApiError("excuse_deadline", "انتهى وقت إرسال الاعتذار. سيتم تسجيل الغياب بدون عذر إذا لم تحضر.", 409)
        try:
            with transaction.atomic():
                ex = BookingExcuse.objects.create(booking=b, student=student, reason=reason)
        except IntegrityError:
            raise ApiError("excuse_exists", "أرسلت اعتذارًا عن هذه الجلسة بالفعل.", 409) from None
        audit("booking.excuse_requested", actor=student, target=b, request=request)  # the reason stays out of the audit
        transaction.on_commit(lambda: _notify_teacher_new(b.pk))
    return ex, True


# ---- the decision on a pending request (session teacher, or an admin with excuses.review) -----------
def review(*, booking_id: int, actor, approve: bool, response: str = "", as_admin: bool = False, request=None) -> BookingExcuse:
    """One decision per request. The teacher may decide only excuses for their own sessions; an admin (the caller has
    checked excuses.review) may decide any pending one. The row is locked: the first decision wins and any later one
    — the other person, another tab, a double click — gets «تمت مراجعة هذا الاعتذار بالفعل.» (nothing overwritten).
    A rejection only records the decision: attendance is not touched (a later «غاب» counts as unexcused)."""
    response = (response or "").strip()[:500]
    if not approve and len(response) < 3:
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"response": ["اكتب سبب رفض الاعتذار."]})
    with transaction.atomic():
        qs = BookingExcuse.objects.select_for_update(of=("self",)).select_related("booking__occurrence").filter(booking_id=booking_id)
        if not as_admin:
            qs = qs.filter(booking__occurrence__teacher=actor)
        ex = qs.first()
        if ex is None:
            raise NOT_FOUND
        if ex.status != E.PENDING:  # the other click (or another tab, or the teacher/admin) already decided
            raise ApiError("already_reviewed", "تمت مراجعة هذا الاعتذار بالفعل.", 409)
        now = timezone.now()
        ex.status = E.APPROVED if approve else E.REJECTED
        ex.reviewed_at, ex.reviewed_by = now, actor
        if as_admin:
            ex.decided_by_role, ex.admin_response = "admin", response
            fields = ["status", "reviewed_at", "reviewed_by", "decided_by_role", "admin_response", "updated_at"]
        else:
            ex.teacher_status, ex.teacher_response, ex.decided_by_role = ex.status, response, "teacher"
            fields = ["status", "teacher_status", "reviewed_at", "reviewed_by", "teacher_response", "decided_by_role", "updated_at"]
        ex.save(update_fields=fields)
        b = Booking.objects.select_for_update().get(pk=ex.booking_id)
        if approve:
            _record_excused(b, actor)
        action = ("booking.excuse_admin_approved" if approve else "booking.excuse_admin_rejected") if as_admin else \
            ("booking.excuse_approved" if approve else "booking.excuse_rejected")
        audit(action, actor=actor, target=b, request=request, decision="approved" if approve else "rejected",
              has_response=bool(response))  # the student's reason and the response text stay out of the audit
        evaluate(b.student_id, trigger_booking_id=b.pk, actor=actor)
        transaction.on_commit(lambda: _notify_decision(ex.pk))
    return ex


def admin_override(*, booking_id: int, admin, reason: str, request=None) -> BookingExcuse:
    """«اعتماد العذر إداريًا»: an audited correction. The teacher's decision stays in teacher_status/teacher_response."""
    reason = (reason or "").strip()[:200]
    if len(reason) < 3:
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"reason": ["اكتب سبب الاعتماد الإداري."]})
    with transaction.atomic():
        b = Booking.objects.select_for_update().filter(pk=booking_id, status=Booking.Status.CONFIRMED).first()
        if b is None:
            raise NOT_FOUND
        ex = BookingExcuse.objects.select_for_update().filter(booking=b).first()
        before = ex.status if ex else ""
        if ex is None:
            ex = BookingExcuse.objects.create(booking=b, student_id=b.student_id, status=E.APPROVED)
        if before == E.APPROVED and ex.override_at:
            return ex
        now = timezone.now()
        ex.status, ex.override_at, ex.override_by, ex.override_reason = E.APPROVED, now, admin, reason
        ex.save(update_fields=["status", "override_at", "override_by", "override_reason", "updated_at"])
        _record_excused(b, admin)
        audit("booking.excuse_admin_override", actor=admin, target=b, request=request, previous=before or "none",
              teacher_decision=ex.teacher_status or "none", reason=reason)
        evaluate(b.student_id, trigger_booking_id=b.pk, actor=admin)
        transaction.on_commit(lambda: _notify_decision(ex.pk))
    return ex


def _record_excused(b: Booking, by) -> None:
    """An approved excuse is recorded as «غاب بعذر» unless the student attended after all."""
    if b.attendance in (Booking.Attendance.UNMARKED, Booking.Attendance.ABSENT):
        b.attendance, b.attendance_marked_by, b.attendance_marked_at = Booking.Attendance.EXCUSED, by, timezone.now()
        b.save(update_fields=["attendance", "attendance_marked_by", "attendance_marked_at", "updated_at"])


def mark_attendance(b: Booking, value: str, teacher) -> str:
    """Teacher's mark, inside the caller's transaction. An absence with an approved excuse is stored as excused."""
    ex = BookingExcuse.objects.filter(booking=b).first()
    if value == Booking.Attendance.ABSENT and ex and ex.status == E.APPROVED:
        value = Booking.Attendance.EXCUSED
    b.attendance, b.attendance_marked_by, b.attendance_marked_at = value, teacher, timezone.now()
    b.save(update_fields=["attendance", "attendance_marked_by", "attendance_marked_at", "updated_at"])
    evaluate(b.student_id, trigger_booking_id=b.pk, actor=teacher)
    return value


# ---- the rule -------------------------------------------------------------------------------
def evaluate(student_id: int, *, trigger_booking_id: int | None = None, actor=None) -> dict:
    """Recount after any change that can move the figure. Warnings and the suspension happen only when the triggering
    booking itself is an unexcused absence; the student row lock makes concurrent calls run one after the other."""
    s = User.objects.select_for_update().filter(pk=student_id, role=Role.STUDENT).first()
    if s is None:
        return {}
    n = unexcused_count(s)
    counts = bool(trigger_booking_id) and Booking.objects.filter(unexcused_q(), pk=trigger_booking_id).exists()
    out = {"unexcused": n, "suspended": False}
    if counts and n >= LIMIT and s.status == AccountStatus.ACTIVE:
        now = timezone.now()
        s.status, s.status_reason, s.status_changed_at = AccountStatus.SUSPENDED, AUTO_REASON, now
        s.save(update_fields=["status", "status_reason", "status_changed_at"])
        AuthToken.objects.filter(user=s, revoked_at__isnull=True).update(revoked_at=now)  # sessions fail on the next request
        audit("student.auto_suspended_absence", actor=None, target=s, student=s.pk, unexcused=n, booking=trigger_booking_id)
        transaction.on_commit(lambda: _notify_suspended(s.pk, trigger_booking_id))
        out["suspended"] = True
    elif counts and n in (1, 2) and s.status == AccountStatus.ACTIVE:
        transaction.on_commit(lambda: _notify_warning(s.pk, n, trigger_booking_id))
    elif not counts and n < LIMIT and s.status == AccountStatus.SUSPENDED and s.status_reason == AUTO_REASON:
        # A correction brought an automatically suspended student below the limit: an admin decides (pilot policy).
        audit("student.absence_suspension_review", actor=actor, target=s, unexcused=n, booking=trigger_booking_id)
        transaction.on_commit(lambda: _notify_admins_review(s.pk, n, trigger_booking_id))
    return out


# ---- notifications (lock screens show only generic text: see notifications/push.py) -------------
def _when(b: Booking, tz: str | None) -> str:
    return b.occurrence.starts_at.astimezone(ZoneInfo(tz or "Africa/Cairo")).strftime("%Y-%m-%d %H:%M")


def _guardians(student_id: int):
    return GuardianLink.objects.filter(student_id=student_id, status=LinkStatus.ACTIVE).select_related("guardian")


def _notify_teacher_new(booking_id: int) -> None:
    from apps.notifications.services import notify

    b = Booking.objects.select_related("occurrence__teacher", "student").get(pk=booking_id)
    t = b.occurrence.teacher
    notify(t, "excuse_new", "طلب اعتذار جديد", f"{b.student.full_name} · {_when(b, t.timezone)}", link="/teacher/schedule",
           dedupe=f"excuse:{b.pk}:new", data={"booking": b.pk})


def _notify_decision(excuse_id: int) -> None:
    from apps.notifications.services import notify

    ex = BookingExcuse.objects.select_related("booking__occurrence__teacher", "student").get(pk=excuse_id)
    b, s = ex.booking, ex.student
    ok = ex.status == E.APPROVED
    when = _when(b, s.timezone)
    body = f"مع {b.occurrence.teacher.full_name} · {when}"
    if not ok and ex.decided_by_role == "admin" and ex.admin_response:
        body += f"\nرد الإدارة: {ex.admin_response}"
    elif not ok and ex.teacher_response:
        body += f"\nرد المعلم: {ex.teacher_response}"
    notify(s, "excuse_approved" if ok else "excuse_rejected",
           "تم قبول اعتذارك عن الجلسة." if ok else "لم يتم قبول الاعتذار عن الجلسة.", body,
           link="/sessions", dedupe=f"excuse:{b.pk}:{ex.status}:{ex.override_at or ex.reviewed_at}", data={"booking": b.pk})
    first = s.full_name.split(" ")[0]
    for g in _guardians(s.pk):
        notify(g.guardian, "excuse_child", f"تم قبول اعتذار {first} عن جلسة {when}" if ok else f"لم يتم قبول اعتذار {first} عن الجلسة.",
               f"مع {b.occurrence.teacher.full_name} · {when}", link="/parent",
               dedupe=f"excuse:{b.pk}:{ex.status}:g{g.guardian_id}:{ex.override_at or ex.reviewed_at}", data={"booking": b.pk, "child": s.pk})
    if ex.decided_by_role == "admin":  # the teacher did not decide it: tell them the final state
        t = b.occurrence.teacher
        notify(t, "excuse_decided", f"{'قبلت' if ok else 'رفضت'} الإدارة اعتذار {s.full_name}", _when(b, t.timezone),
               link="/teacher/schedule", dedupe=f"excuse:{b.pk}:{ex.status}:t:{ex.reviewed_at}", data={"booking": b.pk})


def _notify_warning(student_id: int, n: int, booking_id: int | None) -> None:
    from apps.notifications.services import notify

    s = User.objects.get(pk=student_id)
    if n == 1:
        title, body = "تم تسجيل غياب بدون عذر.", "لديك غياب واحد بدون عذر. عند تجاوز غيابين بدون عذر سيتم إيقاف الحساب."
    else:
        title, body = "تنبيه أخير بسبب الغياب", "لديك غيابان بدون عذر. أي غياب إضافي بدون عذر سيؤدي إلى إيقاف الحساب."
    notify(s, "absence_warning", title, body, link="/sessions", dedupe=f"absence:{booking_id}:{n}", data={"count": n})
    first = s.full_name.split(" ")[0]
    for g in _guardians(s.pk):
        notify(g.guardian, "absence_warning_child",
               f"غياب بدون عذر لـ{first}" if n == 1 else f"تنبيه أخير: غياب {first}",
               f"لدى {first} {'غياب واحد' if n == 1 else 'غيابان'} بدون عذر. عند الغياب الثالث بدون عذر سيُوقف الحساب.",
               link="/parent", dedupe=f"absence:{booking_id}:{n}:g{g.guardian_id}", data={"count": n, "child": s.pk})


def _notify_suspended(student_id: int, booking_id: int | None) -> None:
    from django.conf import settings

    from apps.accounts.emails import send_link_email
    from apps.notifications.services import notify

    s = User.objects.get(pk=student_id)
    body = "تم إيقاف الحساب بسبب تسجيل 3 غيابات بدون عذر مقبول. تواصل مع إدارة حَلْقة لإعادة تفعيل الحساب."
    notify(s, "account_suspended", "تم إيقاف حسابك", body, link="/", dedupe=f"absence:{booking_id}:suspended", data={})
    send_link_email(s.email, subject="تم إيقاف حسابك في حَلْقة", intro=body, cta="فتح حَلْقة", link=f"{settings.FRONTEND_URL}/",
                    expires_at=None, one_time=False)
    first = s.full_name.split(" ")[0]
    for g in _guardians(s.pk):
        notify(g.guardian, "account_suspended_child", f"تم إيقاف حساب {first}",
               f"تم إيقاف حساب {first} بسبب تجاوز الحد المسموح للغياب بدون عذر.", link="/parent",
               dedupe=f"absence:{booking_id}:suspended:g{g.guardian_id}", data={"child": s.pk})
    from apps.accounts.admin_access import admin_users

    for a in admin_users():
        notify(a, "admin_absence_suspension", "إيقاف تلقائي بسبب الغياب", f"{s.full_name}: 3 غيابات بدون عذر.", link="/admin",
               dedupe=f"absence:{booking_id}:suspended:a{a.pk}", data={"student": s.pk})


def _notify_admins_review(student_id: int, n: int, booking_id: int | None) -> None:
    from apps.notifications.services import notify

    s = User.objects.get(pk=student_id)
    from apps.accounts.admin_access import admin_users

    for a in admin_users():
        notify(a, "admin_absence_review", "مراجعة إيقاف بسبب الغياب",
               f"{s.full_name}: صُحّح الحضور وأصبح الغياب بدون عذر {n}. راجع الحساب وأعد تفعيله إن كان مناسبًا.", link="/admin",
               dedupe=f"absence-review:{s.pk}:{booking_id}:{n}", data={"student": s.pk})
