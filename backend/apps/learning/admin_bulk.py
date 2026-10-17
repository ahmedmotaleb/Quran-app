"""Admin courses, lessons and enrollments: validated filters, sort and bulk actions.

Archiving keeps enrollments, completions and grades. Delete is only for drafts with nothing attached: a course with no
lessons, enrollments or quizzes; a lesson nobody completed and no task points to. Enrollments are ended, never deleted.
"""
from __future__ import annotations

from django.utils import timezone

from apps.core.bulk import Action, FilterSpec, Refuse, Resource, Skip, date_range, p_choice, p_date, p_int, p_text, register, search_q

from .models import Assignment, Course, Enrollment, Lesson, PublishState

STATES = (PublishState.DRAFT, PublishState.PENDING, PublishState.PUBLISHED, PublishState.ARCHIVED)


def _courses_apply(qs, f):
    if "state" in f:
        qs = qs.filter(state=f["state"])
    if "teacher" in f:
        qs = qs.filter(teacher_id=f["teacher"])
    if "topic" in f:
        qs = qs.filter(topic=f["topic"])
    if f.get("level"):
        qs = qs.filter(level__iexact=f["level"])
    if f.get("q"):
        qs = qs.filter(search_q(f["q"], ["title", "description", "teacher__full_name"]))
    return date_range(qs, f, "created_at", "created_from", "created_to")


COURSE_FILTERS = FilterSpec(
    parsers={"state": p_choice(*STATES), "teacher": p_int, "topic": p_choice("tajweed", "hifz", "adab", "ulum"), "level": p_text, "q": p_text,
             "created_from": p_date, "created_to": p_date},
    apply=_courses_apply,
    sorts={"title": ("title",), "created": ("created_at",), "updated": ("updated_at",), "state": ("state",)},
    default_sort="-updated",
)


def _course_state(new: str):
    def run(c: Course, actor, reason: str):
        if c.state == new:
            raise Skip("unchanged", "في هذه الحالة بالفعل.")
        if new == PublishState.PUBLISHED and not c.lessons.filter(state=PublishState.PUBLISHED).exists():
            raise Refuse("no_published_lessons", "لا يوجد درس منشور في الدورة.")
        c.state = new
        c.save(update_fields=["state", "updated_at"])
    return run


def _course_delete(c: Course, actor, reason: str):
    if c.state not in (PublishState.DRAFT, PublishState.PENDING):
        raise Refuse("not_draft", "تُحذف المسودات فقط؛ أرشف الدورة بدلًا من ذلك.")
    if c.lessons.exists() or c.enrollments.exists() or c.tests.exists():
        raise Refuse("has_history", "للدورة دروس أو تسجيلات أو اختبارات؛ أرشفها بدلًا من الحذف.")
    c.delete()


register(Resource(
    name="courses", label="learning.course", base=lambda: Course.objects.all(), filters=COURSE_FILTERS, describe=lambda c: c.title,
    actions={
        "publish": Action(_course_state(PublishState.PUBLISHED)),
        "draft": Action(_course_state(PublishState.DRAFT)),
        "archive": Action(_course_state(PublishState.ARCHIVED), reason_required=True),
        "delete": Action(_course_delete, destructive=True),
    },
))


# ---- Lessons (inside a course) ---------------------------------------------------------
LESSON_FILTERS = FilterSpec(
    parsers={"course": p_int, "state": p_choice(*STATES)},
    apply=lambda qs, f: qs.filter(**{k if k != "course" else "course_id": v for k, v in f.items()}),
    sorts={"order": ("order",)}, default_sort="order",
)


def _lesson_state(new: str):
    def run(l: Lesson, actor, reason: str):
        if l.state == new:
            raise Skip("unchanged", "في هذه الحالة بالفعل.")
        l.state = new
        l.save(update_fields=["state", "updated_at"])
        # A published course must keep at least one published lesson (same rule as the single action).
        c = l.course
        if c.state == PublishState.PUBLISHED and not c.lessons.filter(state=PublishState.PUBLISHED).exists():
            raise Refuse("last_published_lesson", "آخر درس منشور في دورة منشورة.")  # the savepoint undoes the change
        if new == PublishState.PUBLISHED and c.state == PublishState.PUBLISHED:
            from .admin_views import notify_enrolled

            notify_enrolled(c, "lesson_published", "درس جديد في دورتك", l.title, dedupe=f"lesson:{l.pk}:published", data={"lesson": l.pk})
    return run


def _lesson_delete(l: Lesson, actor, reason: str):
    if l.state not in (PublishState.DRAFT, PublishState.PENDING):
        raise Refuse("not_draft", "تُحذف المسودات فقط؛ أرشف الدرس بدلًا من ذلك.")
    if l.completions.exists() or Assignment.objects.filter(lesson=l).exists():
        raise Refuse("has_history", "أكمله طلاب أو ترتبط به مهام؛ أرشفه بدلًا من الحذف.")
    l.delete()  # an attached file becomes an orphan upload and is purged by the hourly job


register(Resource(
    name="lessons", label="learning.lesson", base=lambda: Lesson.objects.select_related("course"), filters=LESSON_FILTERS,
    describe=lambda l: l.title,
    actions={
        "publish": Action(_lesson_state(PublishState.PUBLISHED)),
        "draft": Action(_lesson_state(PublishState.DRAFT)),
        "archive": Action(_lesson_state(PublishState.ARCHIVED)),
        "delete": Action(_lesson_delete, destructive=True),
    },
))


# ---- Enrollments (inside a course) -----------------------------------------------------
def _enrollments_apply(qs, f):
    if "course" in f:
        qs = qs.filter(course_id=f["course"])
    if "status" in f:
        qs = qs.filter(status=f["status"])
    if f.get("q"):
        qs = qs.filter(search_q(f["q"], ["student__full_name", "student__email"]))
    return qs


ENROLLMENT_FILTERS = FilterSpec(
    parsers={"course": p_int, "status": p_choice(*Enrollment.Status.values), "q": p_text},
    apply=_enrollments_apply,
    sorts={"created": ("created_at",), "student": ("student__full_name",)}, default_sort="-created",
)


def _enrollment_end(new: str):
    def run(e: Enrollment, actor, reason: str):
        if e.status != Enrollment.Status.ACTIVE:
            raise Skip("unchanged", "منتهٍ بالفعل.")
        e.status, e.ends_on = new, timezone.localdate()
        e.save(update_fields=["status", "ends_on", "updated_at"])
    return run


register(Resource(
    name="enrollments", label="learning.enrollment", base=lambda: Enrollment.objects.select_related("student"), filters=ENROLLMENT_FILTERS,
    describe=lambda e: e.student.full_name,
    actions={"withdraw": Action(_enrollment_end(Enrollment.Status.WITHDRAWN)), "complete": Action(_enrollment_end(Enrollment.Status.COMPLETED))},
))
