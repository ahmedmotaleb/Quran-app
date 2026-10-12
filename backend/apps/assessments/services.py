"""Attempts and grading. Answer keys stay on the server; objective questions are graded here, recitation
and short answers by the student's teacher."""
from __future__ import annotations

from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from apps.core.exceptions import ApiError
from apps.media.models import MediaObject

from .models import Answer, Attempt, Question, Test

AUTO = {Question.Kind.MCQ, Question.Kind.TRUE_FALSE}
GRACE = timedelta(minutes=2)  # network delay after the timer ends


def open_tests():
    now = timezone.now()
    return (Test.objects.filter(state=Test.State.PUBLISHED)
            .exclude(opens_at__gt=now).exclude(closes_at__lt=now))


def live_questions(test: Test):
    return test.questions.filter(retired=False).order_by("order", "id")


def start_attempt(test: Test, student) -> Attempt:
    with transaction.atomic():
        Test.objects.select_for_update().get(pk=test.pk)  # serialise starts for this test
        current = Attempt.objects.filter(test=test, student=student, status=Attempt.Status.IN_PROGRESS).first()
        if current:
            return current
        used = Attempt.objects.filter(test=test, student=student).count()
        if used >= test.max_attempts:
            raise ApiError("no_attempts_left", "استنفدت عدد المحاولات المسموح بها لهذا الاختبار.", 409)
        deadline = timezone.now() + timedelta(minutes=test.duration_minutes) if test.duration_minutes else None
        if test.closes_at and (deadline is None or deadline > test.closes_at):
            deadline = test.closes_at
        return Attempt.objects.create(test=test, student=student, number=used + 1, deadline_at=deadline)


def _correct(q: Question, response) -> bool:
    return response is not None and response == q.answer_key


def submit(attempt: Attempt, answers: list[dict], student) -> Attempt:
    with transaction.atomic():
        a = Attempt.objects.select_for_update().get(pk=attempt.pk)
        if a.status != Attempt.Status.IN_PROGRESS:
            return a  # idempotent: a retried submit returns the stored result
        if a.deadline_at and timezone.now() > a.deadline_at + GRACE:
            raise ApiError("deadline_passed", "انتهى وقت الاختبار.", 409)
        qs = {q.id: q for q in live_questions(a.test)}
        seen = set()
        for item in answers:
            q = qs.get(item.get("question"))
            if q is None or q.id in seen:
                raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"answers": ["سؤال غير صالح."]})
            seen.add(q.id)
            rec = None
            if q.kind == Question.Kind.RECITATION:
                rec = MediaObject.objects.filter(pk=item.get("recording") or None, owner=student, purpose=MediaObject.Purpose.RECITATION,
                                                 state=MediaObject.State.VALIDATED).first() if item.get("recording") else None
                if item.get("recording") and rec is None:
                    raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"answers": ["التسجيل غير صالح."]})
            response = item.get("response")
            if q.kind in AUTO:
                ok = _correct(q, response)
                Answer.objects.create(attempt=a, question=q, response=response, is_correct=ok, points_awarded=q.points if ok else 0)
            elif (q.kind == Question.Kind.RECITATION and rec is None) or (q.kind == Question.Kind.SHORT and not str(response or "").strip()):
                Answer.objects.create(attempt=a, question=q, points_awarded=0, is_correct=False, grade_reason="لم يُجب")
            else:
                Answer.objects.create(attempt=a, question=q, response=str(response).strip()[:500] if q.kind == Question.Kind.SHORT else None, recording=rec)
        # Unanswered auto questions score zero; unanswered manual ones are recorded as zero too (nothing to grade).
        for q in qs.values():
            if q.id not in seen:
                Answer.objects.create(attempt=a, question=q, is_correct=False if q.kind in AUTO else None, points_awarded=0,
                                      grade_reason="لم يُجب" if q.kind not in AUTO else "")
        _finalise(a)
        a.submitted_at = timezone.now()
        a.save(update_fields=["status", "submitted_at", "objective_score", "objective_max", "updated_at"])
        return a


def _finalise(a: Attempt) -> None:
    rows = list(a.answers.select_related("question"))
    a.objective_max = sum(r.question.points for r in rows if r.question.kind in AUTO)
    a.objective_score = sum(r.points_awarded or 0 for r in rows if r.question.kind in AUTO)
    a.status = Attempt.Status.GRADED if all(r.points_awarded is not None for r in rows) else Attempt.Status.SUBMITTED


def grade(answer: Answer, *, points: int, reason: str, teacher) -> Answer:
    with transaction.atomic():
        ans = Answer.objects.select_for_update().select_related("question", "attempt").get(pk=answer.pk)
        if ans.question.kind in AUTO:
            raise ApiError("auto_graded", "هذا السؤال يُصحَّح آليًا.", 409)
        if ans.attempt.status == Attempt.Status.IN_PROGRESS:
            raise ApiError("not_submitted", "لم يُسلَّم الاختبار بعد.", 409)
        if not 0 <= points <= ans.question.points:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"points": [f"بين 0 و {ans.question.points}."]})
        ans.points_awarded, ans.grade_reason, ans.graded_by, ans.graded_at = points, reason[:200], teacher, timezone.now()
        ans.is_correct = points == ans.question.points
        ans.save()
        att = Attempt.objects.select_for_update().get(pk=ans.attempt_id)
        _finalise(att)
        att.save(update_fields=["status", "objective_score", "objective_max", "updated_at"])
        ans.attempt = att
        return ans


def total(a: Attempt) -> tuple[int, int]:
    rows = list(a.answers.select_related("question"))
    return sum(r.points_awarded or 0 for r in rows), sum(r.question.points for r in rows)
