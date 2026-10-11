from django.db.models import Count, Q
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.permissions import IsLearningUser, IsStudent, IsTeacher, assigned_student_ids, scope_by_student
from apps.core.audit import audit
from apps.core.exceptions import ApiError
from apps.media import services as media_services

from . import services
from .models import Answer, Attempt, Question

NOT_FOUND = ApiError("not_found", "العنصر المطلوب غير موجود.", 404)


def _attempt_summary(a: Attempt) -> dict:
    got, mx = services.total(a)
    return {"id": a.id, "number": a.number, "status": a.status, "deadline_at": a.deadline_at, "submitted_at": a.submitted_at,
            "objective_score": a.objective_score, "objective_max": a.objective_max, "score": got if a.status == "graded" else None, "max": mx}


def _test_out(t, attempts) -> dict:
    return {"id": t.id, "title": t.title, "topic": t.topic, "level": t.level, "duration_minutes": t.duration_minutes,
            "max_attempts": t.max_attempts, "question_count": t.q_count, "has_recitation": t.rec_count > 0,
            "closes_at": t.closes_at, "attempts": [_attempt_summary(a) for a in attempts]}


def _annotated():
    live = Q(questions__retired=False)
    return services.open_tests().annotate(q_count=Count("questions", filter=live),
                                          rec_count=Count("questions", filter=live & Q(questions__kind=Question.Kind.RECITATION)))


class TestList(APIView):
    """Published tests open now, with the caller's own attempts."""

    permission_classes = [IsStudent]

    def get(self, request):
        tests = list(_annotated().order_by("-created_at")[:100])
        mine = {}
        for a in Attempt.objects.filter(student=request.user, test__in=tests).order_by("number"):
            mine.setdefault(a.test_id, []).append(a)
        return Response([_test_out(t, mine.get(t.id, [])) for t in tests])


class TestDetail(APIView):
    """Questions without answer keys."""

    permission_classes = [IsStudent]

    def get(self, request, pk):
        t = _annotated().filter(pk=pk).first()
        if t is None:
            raise NOT_FOUND
        qs = [{"id": q.id, "kind": q.kind, "prompt": q.prompt, "options": q.options, "points": q.points} for q in services.live_questions(t)]
        attempts = Attempt.objects.filter(student=request.user, test=t).order_by("number")
        return Response({**_test_out(t, attempts), "questions": qs})


class AttemptStart(APIView):
    permission_classes = [IsStudent]

    def post(self, request, pk):
        t = services.open_tests().filter(pk=pk).first()
        if t is None:
            raise NOT_FOUND
        a = services.start_attempt(t, request.user)
        return Response(_attempt_summary(a), status=201)


def _result(a: Attempt, user, request) -> dict:
    reveal = a.status != Attempt.Status.IN_PROGRESS and a.test.release_results
    rows = []
    for r in a.answers.select_related("question", "recording").order_by("question__order", "question_id"):
        q = r.question
        rows.append({"answer": r.id, "question": q.id, "kind": q.kind, "prompt": q.prompt, "options": q.options, "points": q.points,
                     "response": r.response, "is_correct": r.is_correct, "points_awarded": r.points_awarded, "grade_reason": r.grade_reason,
                     "correct": q.answer_key if reveal and q.kind in services.AUTO else None,
                     "recording": media_services.read_url(r.recording, request) if r.recording and media_services.can_read(user, r.recording) else None})
    return {**_attempt_summary(a), "test": a.test_id, "test_title": a.test.title, "student_name": a.student.full_name, "answers": rows}


class AttemptSubmit(APIView):
    """Submit all answers at once: `{answers: [{question, response?, recording?}]}`. Idempotent."""

    permission_classes = [IsStudent]

    def post(self, request, pk):
        a = Attempt.objects.select_related("test").filter(pk=pk, student=request.user).first()
        if a is None:
            raise NOT_FOUND
        answers = request.data.get("answers")
        if not isinstance(answers, list):
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"answers": ["أرسل الإجابات."]})
        a = services.submit(a, answers, request.user)
        audit("attempt.submitted", actor=request.user, target=a, request=request, status=a.status)
        return Response(_result(a, request.user, request))


class AttemptDetail(APIView):
    """Owner, the student's teacher, linked parents, admins (scoped like other learning records)."""

    permission_classes = [IsLearningUser]

    def get(self, request, pk):
        a = scope_by_student(Attempt.objects.select_related("test", "student"), request.user).filter(pk=pk).first()
        if a is None:
            raise NOT_FOUND
        return Response(_result(a, request.user, request))


class PendingGrading(APIView):
    """Recitation / short answers from the teacher's students that still need a grade."""

    permission_classes = [IsTeacher]

    def get(self, request):
        qs = (Answer.objects.filter(attempt__student_id__in=assigned_student_ids(request.user), points_awarded__isnull=True,
                                    attempt__status=Attempt.Status.SUBMITTED)
              .select_related("question", "attempt__test", "attempt__student", "recording").order_by("attempt__submitted_at")[:100])
        return Response([{"answer": r.id, "attempt": r.attempt_id, "test_title": r.attempt.test.title, "student": r.attempt.student_id,
                          "student_name": r.attempt.student.full_name, "kind": r.question.kind, "prompt": r.question.prompt,
                          "points": r.question.points, "response": r.response, "submitted_at": r.attempt.submitted_at,
                          "recording": media_services.read_url(r.recording, request) if r.recording and media_services.can_read(request.user, r.recording) else None,
                          "duration_seconds": r.recording.duration_seconds if r.recording else None} for r in qs])


class GradeAnswer(APIView):
    permission_classes = [IsTeacher]

    def post(self, request, pk):
        r = Answer.objects.filter(pk=pk, attempt__student_id__in=assigned_student_ids(request.user)).first()
        if r is None:
            raise NOT_FOUND
        try:
            points = int(request.data.get("points"))
        except (TypeError, ValueError):
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"points": ["أدخل الدرجة."]}) from None
        r = services.grade(r, points=points, reason=str(request.data.get("reason", "")), teacher=request.user)
        audit("answer.graded", actor=request.user, target=r, request=request, points=points)
        return Response({"answer": r.id, "points_awarded": r.points_awarded, "attempt_status": r.attempt.status})
