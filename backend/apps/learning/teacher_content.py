"""Teacher content authoring (pack prompt 07, teacher side).

Teachers write DRAFTS: lessons in their own courses, new draft courses, and quizzes they author. Publishing stays
with the admins (the portal's "waiting to be published" list), so nothing reaches students unreviewed. Once an admin
publishes something, the teacher can no longer change it here: the material students see, complete and are graded
on stays stable. The same validation as the admin console is reused (one content system, not two).
"""
from __future__ import annotations

from django.db import transaction
from rest_framework.generics import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.permissions import IsAdminRole, IsTeacher
from apps.assessments.admin_views import QuestionIn, TestIn, _test_out, _tests
from apps.assessments.models import Question, Test
from apps.core.audit import audit
from apps.core.exceptions import ApiError

from .admin_views import CourseIn, LessonIn, _course_out, _courses, _lesson_out
from .models import Course, Lesson, PublishState

LOCKED = ApiError("published_locked", "نُشر هذا المحتوى؛ تعديله الآن عن طريق إدارة الحلقة حتى لا يتغير ما يدرسه الطلاب.", 409)


def _own_course(user, pk) -> Course:
    c = get_object_or_404(Course, pk=pk, teacher=user)  # another teacher's course is simply not found
    if c.state == PublishState.ARCHIVED:
        raise ApiError("archived", "هذه الدورة مؤرشفة.", 409)
    return c


class TeacherContent(APIView):
    """Everything this teacher can author, with each item's state."""

    permission_classes = [IsTeacher]

    def get(self, request):
        courses = _courses().filter(teacher=request.user).exclude(state=PublishState.ARCHIVED).order_by("-updated_at")
        out = []
        for c in courses:
            out.append({**_course_out(c), "lesson_list": [_lesson_out(l) for l in c.lessons.exclude(state=PublishState.ARCHIVED).order_by("order", "id")]})
        tests = _tests().filter(author=request.user).order_by("-updated_at")
        return Response({"courses": out, "tests": [_test_out(t) for t in tests],
                         "rule": "يحفظ المعلم المحتوى كمسودة، وتنشره إدارة الحلقة بعد المراجعة."})


class TeacherCourses(APIView):
    permission_classes = [IsTeacher]

    def post(self, request):
        s = CourseIn(data={**request.data, "teacher": request.user.pk})  # always the requesting teacher
        s.is_valid(raise_exception=True)
        d = {k: v for k, v in s.validated_data.items() if k != "restricted"}  # access rules are an admin decision
        c = Course.objects.create(**d)
        audit("teacher.course_drafted", actor=request.user, target=c, request=request, title=c.title)
        return Response(_course_out(_courses().get(pk=c.pk)), status=201)


class TeacherLessons(APIView):
    permission_classes = [IsTeacher]

    def post(self, request, pk):
        c = _own_course(request.user, pk)
        s = LessonIn(data=request.data, context={"request": request})
        s.is_valid(raise_exception=True)
        d = s.validated_data
        if "order" not in d:
            d["order"] = (c.lessons.order_by("-order").values_list("order", flat=True).first() or 0) + 1
        l = Lesson.objects.create(course=c, **d)  # draft by default
        audit("teacher.lesson_drafted", actor=request.user, target=l, request=request, course=c.id)
        return Response(_lesson_out(l), status=201)


class TeacherLessonDetail(APIView):
    permission_classes = [IsTeacher]

    def _get(self, request, pk) -> Lesson:
        l = get_object_or_404(Lesson.objects.select_related("course"), pk=pk, course__teacher=request.user)
        if l.state != PublishState.DRAFT:
            raise LOCKED
        return l

    def patch(self, request, pk):
        l = self._get(request, pk)
        s = LessonIn(l, data=request.data, partial=True, context={"request": request})
        s.is_valid(raise_exception=True)
        for k, v in s.validated_data.items():
            setattr(l, k, v)
        l.save()
        audit("teacher.lesson_updated", actor=request.user, target=l, request=request, fields=sorted(s.validated_data))
        return Response(_lesson_out(l))

    def delete(self, request, pk):
        l = self._get(request, pk)  # drafts were never visible to students: nothing to preserve
        audit("teacher.lesson_deleted", actor=request.user, target=l, request=request, title=l.title)
        l.delete()
        return Response(status=204)


class TeacherTests(APIView):
    """A quiz and its questions in one request, saved together as a draft."""

    permission_classes = [IsTeacher]

    def post(self, request):
        s = TestIn(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        if d.get("course") and d["course"].teacher_id != request.user.pk:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"course": ["اختر دورة من دوراتك."]})
        raw = request.data.get("questions") or []
        if not isinstance(raw, list) or not 1 <= len(raw) <= 50:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"questions": ["أضف من سؤال إلى 50 سؤالًا."]})
        qs, errors = [], {}
        for i, q in enumerate(raw):
            qi = QuestionIn(data=q)
            if qi.is_valid():
                qs.append(qi.validated_data)
            else:
                errors[str(i)] = qi.errors
        if errors:
            raise ApiError("invalid", "تحقق من الأسئلة.", 400, {"questions": errors})
        with transaction.atomic():
            t = Test.objects.create(author=request.user, **d)  # draft by default
            for i, q in enumerate(qs, 1):
                Question.objects.create(test=t, order=q.pop("order", i), **q)
        audit("teacher.test_drafted", actor=request.user, target=t, request=request, questions=len(qs))
        return Response(_test_out(_tests().get(pk=t.pk)), status=201)


class TeacherTestDetail(APIView):
    permission_classes = [IsTeacher]

    def delete(self, request, pk):
        t = get_object_or_404(Test, pk=pk, author=request.user)
        if t.state != PublishState.DRAFT or t.attempts.exists():
            raise LOCKED
        audit("teacher.test_deleted", actor=request.user, target=t, request=request, title=t.title)
        t.delete()
        return Response(status=204)


class AdminContentDrafts(APIView):
    """What waits for an admin to review and publish: draft lessons (in courses that are not archived) and draft
    quizzes, with how many came from teachers."""

    permission_classes = [IsAdminRole]

    def get(self, request):
        lessons = Lesson.objects.filter(state=PublishState.DRAFT).exclude(course__state=PublishState.ARCHIVED)
        tests = Test.objects.filter(state=Test.State.DRAFT)
        return Response({"lessons": lessons.count(), "tests": tests.count(),
                         "lessons_by_teachers": lessons.filter(course__teacher__role="teacher").count(),
                         "tests_by_teachers": tests.filter(author__role="teacher").count()})
