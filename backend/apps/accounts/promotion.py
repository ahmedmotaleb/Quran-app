"""Student → Teacher promotion (owner decision, 23 October 2026).

One deliberate, one-way, one-account action: the SAME user (id, email, password, history) becomes a teacher.
No other role change exists, and there is no bulk version.

- History stays linked to the same user id: submissions, feedback, scores, attendance, mistakes, quiz attempts,
  unfinished assignments and the StudentProfile (kept as history; teacher screens do not use it).
- What only makes sense for a learner ends now: active teacher links, circle memberships, future bookings (cancelled
  with «تمت ترقية الحساب إلى معلم»), guardian links to this account as a child, active course enrollments
  (withdrawn) and spaced-review schedules (stopped).
- A TeacherProfile is created with blank details; the teacher is NOT approved unless the admin asks for it.
- Every signed-in device is signed out (tokens revoked, sessions deleted); the next sign-in opens the teacher app.
- Audit: `admin.user_promoted_to_teacher` with the reason, approval and counts. Optional email (no password).
"""
from __future__ import annotations

from django.contrib.auth import SESSION_KEY
from django.contrib.sessions.models import Session
from django.db import transaction
from django.utils import timezone

from apps.core.audit import audit

from .models import AccountStatus, AuthToken, GuardianLink, LinkStatus, Role, TeacherAssignment, TeacherProfile, User

CANCEL_REASON = "تمت ترقية الحساب إلى معلم"


class PromotionRefused(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def _end_sessions(user: User) -> int:
    """Delete this user's browser sessions (app and admin portal share the session table)."""
    n = 0
    for s in Session.objects.filter(expire_date__gt=timezone.now()).iterator():
        try:
            if s.get_decoded().get(SESSION_KEY) == str(user.pk):
                s.delete()
                n += 1
        except Exception:  # noqa: BLE001 — an unreadable session is not this user's
            continue
    return n


def promote_to_teacher(user_id: int, actor, *, reason: str, approve: bool = False, request=None) -> dict:
    from apps.learning.models import Enrollment, ReviewSchedule
    from apps.scheduling.models import Booking, CircleMember

    now = timezone.now()
    with transaction.atomic():
        u = User.objects.select_for_update().filter(pk=user_id).first()
        if u is None or u.role == Role.ADMIN:
            raise PromotionRefused("not_found", "العنصر المطلوب غير موجود.")
        if u.status == AccountStatus.DELETED:
            raise PromotionRefused("deleted", "هذا الحساب محذوف ولا يمكن ترقيته.")
        if u.role != Role.STUDENT:
            raise PromotionRefused("not_student", "الترقية إلى معلم متاحة لحسابات الطلاب فقط.")
        if u.status == AccountStatus.ARCHIVED:
            raise PromotionRefused("archived", "الحساب مؤرشف؛ أعد تفعيله أولًا ثم رقِّه.")
        counts = {
            "assignments_ended": TeacherAssignment.objects.filter(student=u, active=True).update(active=False, ended_at=now),
            "memberships_ended": CircleMember.objects.filter(student=u, active=True).update(
                active=False, ended_at=now, ended_by=actor, end_reason=CANCEL_REASON, updated_at=now),
            "bookings_cancelled": Booking.objects.filter(student=u, status=Booking.Status.CONFIRMED, occurrence__starts_at__gt=now).update(
                status=Booking.Status.CANCELLED, cancelled_at=now, cancelled_by=actor, cancel_reason=CANCEL_REASON, updated_at=now),
            "guardian_links_revoked": GuardianLink.objects.filter(student=u, status__in=[LinkStatus.ACTIVE, LinkStatus.PENDING]).update(
                status=LinkStatus.REVOKED, updated_at=now),
            "enrollments_withdrawn": Enrollment.objects.filter(student=u, status=Enrollment.Status.ACTIVE).update(
                status=Enrollment.Status.WITHDRAWN, ends_on=timezone.localdate()),
            "review_plans_stopped": ReviewSchedule.objects.filter(student=u, active=True).update(active=False),
        }
        u.role = Role.TEACHER
        u.save(update_fields=["role"])
        prof, created = TeacherProfile.objects.get_or_create(user=u)
        prof.approved_at = now if approve else None
        prof.save(update_fields=["approved_at"])
        counts["tokens_revoked"] = AuthToken.objects.filter(user=u, revoked_at__isnull=True).update(revoked_at=now)
        counts["sessions_ended"] = _end_sessions(u)
        audit("admin.user_promoted_to_teacher", actor=actor, target=u, request=request, old_role=Role.STUDENT,
              new_role=Role.TEACHER, reason=reason, approved=approve, **counts)
    emailed = _notify(u, approve)
    return {"user": u, "approved": approve, "emailed": emailed, **counts}


def _notify(u: User, approved: bool) -> bool:
    from django.conf import settings

    from .emails import send_link_email

    intro = "تمت ترقية حسابك إلى حساب معلم. يمكنك تسجيل الدخول بنفس البريد وكلمة المرور."
    if not approved:
        intro += " سيظهر حسابك للطلاب بعد اعتماده من الإدارة."
    return send_link_email(u.email, subject="تم تحديث حسابك في حَلْقة", intro=intro, cta="تسجيل الدخول",
                           link=f"{settings.FRONTEND_URL}/", expires_at=None, one_time=False)
