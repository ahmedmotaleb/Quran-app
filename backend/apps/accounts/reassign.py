"""Assigning a student's Quran teacher — the ONE place that changes it (owner report, 14 Nov 2026).

Business rule: a student has at most one active teacher (database constraint `one_active_teacher_per_student`).
`assign_teacher` runs in a single transaction:
- lock the student row, so concurrent reassignments are serialized; the last one wins and none fails half-way;
- end the current assignment (`active=False`, `ended_at`, `ended_by`, `end_reason="reassigned"`). The row is kept
  as history, never deleted;
- create the new active assignment;
- create the in-app notifications for the student, the new teacher and the previous teacher IN THE SAME
  TRANSACTION. This is the outbox: they exist only if the reassignment committed. Web Push is sent after commit,
  failures are recorded on the notification (push_status / attempts / error), and the hourly job retries them. A push
  outage never undoes the reassignment.

Historical tasks, recordings, evaluations, attendance and memorization progress are untouched. The previous teacher
keeps the tasks they created (as before) but no longer sees the student, the student's submissions, or anything new.
"""
from __future__ import annotations

from django.db import transaction
from django.utils import timezone

from apps.core.exceptions import ApiError

from .models import AccountStatus, Role, TeacherAssignment, User


def teacher_title(t: User) -> str:
    """«الأستاذ فلان» / «الأستاذة فلانة»; no title when the gender is not set (never «الشيخ»)."""
    name = t.full_name.strip()
    return f"الأستاذة {name}" if t.gender == "female" else f"الأستاذ {name}" if t.gender == "male" else name


def _student_word(s: User) -> str:
    return "الطالبة" if s.gender == "female" else "الطالب"


def validate(student: User | None, teacher: User | None) -> None:
    if student is None or student.role != Role.STUDENT:
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"student": ["اختر حساب طالب."]})
    if student.status in (AccountStatus.SUSPENDED, AccountStatus.ARCHIVED) or not student.is_active:
        raise ApiError("inactive", "حساب الطالب موقوف أو مؤرشف.", 409)
    if teacher is None or teacher.role != Role.TEACHER or teacher.status != AccountStatus.ACTIVE or not teacher.is_active:
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"teacher": ["المعلم غير نشط."]})
    profile = getattr(teacher, "teacher_profile", None)
    if not (profile and profile.approved_at):
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"teacher": ["المعلم غير معتمد."]})


def assign_teacher(student: User, teacher: User, actor: User | None, *, source: str, notify_users: bool = True,
                   tell_student: bool = True, request=None) -> tuple[TeacherAssignment, TeacherAssignment | None, bool]:
    """Make `teacher` the student's only active teacher. Returns (active assignment, ended assignment or None, changed).
    Assigning the teacher the student already has changes nothing and notifies no one (idempotent)."""
    from apps.core.audit import audit
    from apps.notifications.services import notify

    validate(student, teacher)
    with transaction.atomic():
        User.objects.select_for_update().filter(pk=student.pk).first()  # serialize reassignments of this student
        current = TeacherAssignment.objects.select_for_update().filter(student=student, active=True).select_related("teacher").first()
        if current and current.teacher_id == teacher.pk:
            return current, None, False
        now = timezone.now()
        if current:
            current.active, current.ended_at, current.ended_by, current.end_reason = False, now, actor, "reassigned"
            current.save(update_fields=["active", "ended_at", "ended_by", "end_reason", "updated_at"])
        new = TeacherAssignment.objects.create(teacher=teacher, student=student, created_by=actor)
        audit("admin.teacher_reassigned" if current else "admin.teacher_assigned", actor=actor, target=new, request=request, source=source,
              student=student.pk, teacher=teacher.pk, previous_teacher=current.teacher_id if current else None)
        if notify_users:
            t = teacher_title(teacher)
            with_word = "معها" if teacher.gender == "female" else "معه"
            role_word = "معلمةً" if teacher.gender == "female" else "معلمًا"
            if tell_student:  # (an «اختر معلمك» decision tells the student through the request instead)
                notify(student, "teacher_assigned", "تم تغيير معلمك في حلقة" if current else "تم تعيين معلمك في حلقة",
                       f"تم تعيين {t} {role_word} لك. يمكنك الآن متابعة الحفظ والمراجعة {with_word}.",
                       link="/", dedupe=f"assignment:{new.pk}:student", data={"assignment": new.pk, "teacher": teacher.pk, "sync": "assignment"})
            notify(teacher, "student_assigned", "طالب جديد في حلقتك", f"تم تعيين {_student_word(student)} {student.full_name} ضمن طلابك.",
                   link="/teacher/students", dedupe=f"assignment:{new.pk}:teacher",
                   data={"assignment": new.pk, "student": student.pk, "sync": "assignment"})
            if current:
                notify(current.teacher, "student_moved", "تحديث قائمة الطلاب", f"تم نقل {_student_word(student)} {student.full_name} إلى معلم آخر.",
                       link="/teacher/students", dedupe=f"assignment:{current.pk}:moved", data={"assignment": current.pk, "sync": "assignment"})
        return new, current, True


def end_assignment(a: TeacherAssignment, actor: User | None, *, reason: str = "ended", request=None) -> None:
    """Unlink without a replacement (admin «إنهاء الارتباط»). History kept."""
    from apps.core.audit import audit

    with transaction.atomic():
        n = TeacherAssignment.objects.filter(pk=a.pk, active=True).update(active=False, ended_at=timezone.now(), ended_by=actor,
                                                                       end_reason=reason, updated_at=timezone.now())
        if n:
            audit("admin.teacher_unassigned", actor=actor, target=a, request=request)


def current_teacher(student: User) -> User | None:
    a = TeacherAssignment.objects.filter(student=student, active=True).select_related("teacher").first()
    return a.teacher if a else None
