"""Admin portal: quizzes and their questions (pack prompt 07).

Questions are versioned: editing or removing a question that any attempt has used retires that version (kept,
with its answers) and, for edits, creates a new version for future attempts. Attempts in progress keep the
versions they started with (services.attempt_questions). Answer keys are only ever returned here, to admins.
"""
from __future__ import annotations

from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import serializers
from rest_framework.generics import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.permissions import IsAdminRole
from apps.core.audit import audit
from apps.core.exceptions import ApiError
from apps.core.pagination import StandardPagination
from apps.learning.models import Course

from .models import Answer, Attempt, Question, Test


class AdminView(APIView):
    permission_classes = [IsAdminRole]


def _surah_sizes() -> dict[int, int]:
    """Ayah counts from the active verified source; the standard Hafs counts if none is imported yet."""
    from apps.quran.models import HAFS_AYAH_COUNTS, Surah

    rows = dict(Surah.objects.filter(source__is_active=True).values_list("number", "ayah_count"))
    return rows or {i + 1: n for i, n in enumerate(HAFS_AYAH_COUNTS)}


class TestIn(serializers.Serializer):
    title = serializers.CharField(min_length=2, max_length=160)
    course = serializers.PrimaryKeyRelatedField(queryset=Course.objects.all(), required=False, allow_null=True)
    topic = serializers.ChoiceField(choices=["tajweed", "hifz", "adab", "ulum"], required=False, allow_blank=True)
    level = serializers.CharField(max_length=32, required=False, allow_blank=True)
    duration_minutes = serializers.IntegerField(min_value=1, max_value=240, required=False, allow_null=True)
    max_attempts = serializers.IntegerField(min_value=1, max_value=10, required=False)
    opens_at = serializers.DateTimeField(required=False, allow_null=True)
    closes_at = serializers.DateTimeField(required=False, allow_null=True)
    release_results = serializers.BooleanField(required=False)

    def validate(self, d):
        o, c = d.get("opens_at"), d.get("closes_at")
        if o and c and c <= o:
            raise serializers.ValidationError({"closes_at": ["يجب أن يكون الإغلاق بعد الفتح."]})
        return d


class QuestionIn(serializers.Serializer):
    kind = serializers.ChoiceField(choices=Question.Kind.choices)
    prompt = serializers.CharField(min_length=3, max_length=2000)
    options = serializers.JSONField(required=False)
    answer_key = serializers.JSONField(required=False, allow_null=True)
    points = serializers.IntegerField(min_value=1, max_value=50, required=False)
    order = serializers.IntegerField(min_value=0, max_value=999, required=False)

    def validate(self, d):
        k, opts, key = d["kind"], d.get("options"), d.get("answer_key")
        if k == Question.Kind.MCQ:
            if not isinstance(opts, list) or not 2 <= len(opts) <= 6 or any(not isinstance(o, str) or not o.strip() for o in opts):
                raise serializers.ValidationError({"options": ["من 2 إلى 6 خيارات غير فارغة."]})
            if len({o.strip() for o in opts}) != len(opts):
                raise serializers.ValidationError({"options": ["الخيارات مكررة."]})
            if not isinstance(key, int) or isinstance(key, bool) or not 0 <= key < len(opts):
                raise serializers.ValidationError({"answer_key": ["اختر الإجابة الصحيحة."]})
            d["options"] = [o.strip() for o in opts]
        elif k == Question.Kind.TRUE_FALSE:
            if not isinstance(key, bool):
                raise serializers.ValidationError({"answer_key": ["اختر صح أو خطأ."]})
            d["options"] = []
        elif k == Question.Kind.SHORT:  # graded by a teacher; an optional model answer guides them
            d["options"] = []
            d["answer_key"] = str(key).strip()[:500] if key else None
        else:  # recitation: an optional Quran range, checked against the verified source
            d["answer_key"] = None
            ref = opts if isinstance(opts, dict) else {}
            if ref:
                try:
                    s, a, b = int(ref.get("surah")), int(ref.get("ayah_from")), int(ref.get("ayah_to"))
                except (TypeError, ValueError):
                    raise serializers.ValidationError({"options": ["حدّد السورة والآيات."]}) from None
                size = _surah_sizes().get(s)
                if not size or not 1 <= a <= b <= size:
                    raise serializers.ValidationError({"options": [f"نطاق غير صحيح: السورة {s} فيها {size or 0} آية."]})
                d["options"] = {"surah": s, "ayah_from": a, "ayah_to": b}
            else:
                d["options"] = {}
        return d


def _q_out(q: Question) -> dict:
    return {"id": q.id, "order": q.order, "version": q.version, "kind": q.kind, "prompt": q.prompt, "options": q.options,
            "answer_key": q.answer_key, "points": q.points, "used": getattr(q, "n_answers", None)}


def _tests():
    live = Q(questions__retired=False)
    return Test.objects.select_related("course", "author").annotate(
        n_questions=Count("questions", filter=live, distinct=True),
        n_attempts=Count("attempts", filter=~Q(attempts__status=Attempt.Status.IN_PROGRESS), distinct=True))


def _test_out(t: Test) -> dict:
    return {"id": t.id, "title": t.title, "course": {"id": t.course_id, "title": t.course.title} if t.course_id else None,
            "topic": t.topic, "level": t.level, "state": t.state, "duration_minutes": t.duration_minutes, "max_attempts": t.max_attempts,
            "opens_at": t.opens_at.isoformat() if t.opens_at else None, "closes_at": t.closes_at.isoformat() if t.closes_at else None,
            "release_results": t.release_results, "questions": getattr(t, "n_questions", None), "attempts": getattr(t, "n_attempts", None),
            "updated_at": t.updated_at.isoformat()}


def _page(view, request, qs, fn):
    p = StandardPagination()
    return p.get_paginated_response([fn(x) for x in p.paginate_queryset(qs, request, view=view)])


class AdminTests(AdminView):
    def get(self, request):
        from apps.core.bulk import list_with

        from .admin_bulk import TEST_FILTERS

        return list_with(self, request, _tests(), TEST_FILTERS, _test_out)

    def post(self, request):
        s = TestIn(data=request.data)
        s.is_valid(raise_exception=True)
        t = Test.objects.create(author=request.user, **s.validated_data)  # draft
        audit("admin.test_created", actor=request.user, target=t, request=request, title=t.title)
        return Response(_test_out(_tests().get(pk=t.pk)), status=201)


class AdminTestDetail(AdminView):
    def get(self, request, pk):
        t = get_object_or_404(_tests(), pk=pk)
        qs = t.questions.filter(retired=False)
        used = dict(Answer.objects.filter(question__in=qs).values("question").annotate(n=Count("id")).values_list("question", "n"))
        out = []
        for q in qs.order_by("order", "id"):
            q.n_answers = used.get(q.id, 0)
            out.append(_q_out(q))
        return Response({**_test_out(t), "question_list": out})

    def patch(self, request, pk):
        t = get_object_or_404(Test, pk=pk)
        s = TestIn(data=request.data, partial=True)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        o, c = d.get("opens_at", t.opens_at), d.get("closes_at", t.closes_at)
        if o and c and c <= o:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"closes_at": ["يجب أن يكون الإغلاق بعد الفتح."]})
        for k, v in d.items():
            setattr(t, k, v)
        t.save()
        audit("admin.test_updated", actor=request.user, target=t, request=request, fields=sorted(d))
        return Response(_test_out(_tests().get(pk=t.pk)))


class AdminTestState(AdminView):
    """draft → published (students can attempt) → closed (no new attempts; results and history kept)."""

    def post(self, request, pk):
        t = get_object_or_404(Test, pk=pk)
        new = request.data.get("state")
        if new not in (Test.State.DRAFT, Test.State.PUBLISHED, Test.State.CLOSED):
            raise ApiError("invalid", "حالة غير صالحة.", 400, {"state": ["اختر حالة صالحة."]})
        if new == Test.State.PUBLISHED and not t.questions.filter(retired=False).exists():
            raise ApiError("no_questions", "أضف سؤالًا واحدًا على الأقل قبل النشر.", 409)
        old = t.state
        t.state = new
        t.save(update_fields=["state", "updated_at"])
        audit("admin.test_state", actor=request.user, target=t, request=request, old=old, new=new)
        if new == Test.State.PUBLISHED and old != new and t.course_id:
            from apps.learning.admin_views import notify_enrolled
            notify_enrolled(t.course, "quiz_published", "اختبار جديد في دورتك", t.title, dedupe=f"test:{t.pk}:published", data={"test": t.pk})
        return Response(_test_out(_tests().get(pk=t.pk)))


class AdminQuestions(AdminView):
    def post(self, request, pk):
        t = get_object_or_404(Test, pk=pk)
        if t.state == Test.State.CLOSED:
            raise ApiError("closed", "الاختبار مغلق. أعده إلى مسودة لتعديله.", 409)
        s = QuestionIn(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        if "order" not in d:
            d["order"] = (t.questions.filter(retired=False).order_by("-order").values_list("order", flat=True).first() or 0) + 1
        q = Question.objects.create(test=t, **d)
        audit("admin.question_created", actor=request.user, target=q, request=request, test=t.id)
        return Response(_q_out(q), status=201)


class AdminQuestionDetail(AdminView):
    def patch(self, request, pk):
        q = get_object_or_404(Question.objects.select_related("test"), pk=pk, retired=False)
        if q.test.state == Test.State.CLOSED:
            raise ApiError("closed", "الاختبار مغلق. أعده إلى مسودة لتعديله.", 409)
        merged = {"kind": q.kind, "prompt": q.prompt, "options": q.options, "answer_key": q.answer_key, "points": q.points,
                  "order": q.order, **request.data}
        s = QuestionIn(data=merged)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        now = timezone.now()
        with transaction.atomic():
            if Answer.objects.filter(question=q).exists() or Attempt.objects.filter(test=q.test, started_at__gte=q.created_at).exists():
                # Used by an attempt (or possibly shown to one in progress): keep this version, add a new one.
                Question.objects.filter(pk=q.pk).update(retired=True, retired_at=now)
                new = Question.objects.create(test=q.test, version=q.version + 1, created_at=now, **d)
                audit("admin.question_versioned", actor=request.user, target=new, request=request, previous=q.id)
                return Response(_q_out(new))
            for k, v in d.items():
                setattr(q, k, v)
            q.save()
        audit("admin.question_updated", actor=request.user, target=q, request=request)
        return Response(_q_out(q))

    def delete(self, request, pk):
        q = get_object_or_404(Question.objects.select_related("test"), pk=pk, retired=False)
        if q.test.state == Test.State.PUBLISHED and q.test.questions.filter(retired=False).count() == 1:
            raise ApiError("last_question", "لا يمكن حذف آخر سؤال في اختبار منشور. أعده إلى مسودة أولًا.", 409)
        # Never hard-delete: answers and attempts may point at it.
        Question.objects.filter(pk=q.pk).update(retired=True, retired_at=timezone.now())
        audit("admin.question_removed", actor=request.user, target=q, request=request)
        return Response(status=204)
