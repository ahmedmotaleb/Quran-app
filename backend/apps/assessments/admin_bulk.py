"""Admin quizzes and questions: validated filters, sort and bulk actions.

Closing keeps every attempt and grade. Delete is only for draft quizzes that nobody attempted. Questions are never
hard-deleted once answered: removing one retires it (the same rule as the single remove button).
"""
from __future__ import annotations

from django.utils import timezone

from apps.core.bulk import Action, FilterSpec, Refuse, Resource, Skip, date_range, p_choice, p_date, p_int, p_text, register, search_q

from .models import Question, Test


def _tests_apply(qs, f):
    if "state" in f:
        qs = qs.filter(state=f["state"])
    if "course" in f:
        qs = qs.filter(course_id=f["course"])
    if "teacher" in f:
        qs = qs.filter(author_id=f["teacher"])
    if f.get("level"):
        qs = qs.filter(level__iexact=f["level"])
    if f.get("q"):
        qs = qs.filter(search_q(f["q"], ["title", "course__title"]))
    return date_range(qs, f, "created_at", "created_from", "created_to")


TEST_FILTERS = FilterSpec(
    parsers={"state": p_choice(*Test.State.values), "course": p_int, "teacher": p_int, "level": p_text, "q": p_text,
             "created_from": p_date, "created_to": p_date},
    apply=_tests_apply,
    sorts={"title": ("title",), "created": ("created_at",), "updated": ("updated_at",), "state": ("state",)},
    default_sort="-updated",
)


def _test_state(new: str):
    def run(t: Test, actor, reason: str):
        if t.state == new:
            raise Skip("unchanged", "في هذه الحالة بالفعل.")
        if new == Test.State.PUBLISHED and not t.questions.filter(retired=False).exists():
            raise Refuse("no_questions", "لا توجد أسئلة في الاختبار.")
        t.state = new
        t.save(update_fields=["state", "updated_at"])
    return run


def _test_delete(t: Test, actor, reason: str):
    if t.state not in (Test.State.DRAFT, Test.State.PENDING):
        raise Refuse("not_draft", "تُحذف المسودات فقط؛ أغلق الاختبار بدلًا من ذلك.")
    if t.attempts.exists():
        raise Refuse("has_history", "للاختبار محاولات محفوظة؛ أغلقه بدلًا من الحذف.")
    t.delete()  # its unanswered questions go with it


register(Resource(
    name="tests", label="assessments.test", base=lambda: Test.objects.all(), filters=TEST_FILTERS, describe=lambda t: t.title,
    actions={
        "publish": Action(_test_state(Test.State.PUBLISHED)),
        "close": Action(_test_state(Test.State.CLOSED)),
        "draft": Action(_test_state(Test.State.DRAFT)),
        "delete": Action(_test_delete, destructive=True),
    },
))


def _question_remove(q: Question, actor, reason: str):
    if q.retired:
        raise Skip("unchanged", "محذوف بالفعل.")
    t = q.test
    if t.state == Test.State.CLOSED:
        raise Refuse("closed", "الاختبار مغلق.")
    if t.state == Test.State.PUBLISHED and not t.questions.filter(retired=False).exclude(pk=q.pk).exists():
        raise Refuse("last_question", "آخر سؤال في اختبار منشور.")
    Question.objects.filter(pk=q.pk).update(retired=True, retired_at=timezone.now())  # answers keep pointing at it


register(Resource(
    name="questions", label="assessments.question", base=lambda: Question.objects.select_related("test"),
    filters=FilterSpec(parsers={"test": p_int}, apply=lambda qs, f: qs.filter(retired=False, **({"test_id": f["test"]} if "test" in f else {})),
                       sorts={"order": ("order",)}, default_sort="order"),
    describe=lambda q: q.prompt[:60],
    actions={"remove": Action(_question_remove, destructive=True)},
))
