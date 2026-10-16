"""Prompt 09/15: lesson library, quizzes with server-side grading, teacher grading."""
from datetime import timedelta

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone

from apps.assessments.models import Attempt, Question
from apps.assessments.models import Test as Quiz
from apps.learning.models import Course, Lesson, LessonCompletion

from .conftest import client_for


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    settings.MEDIA_STORAGE, settings.MEDIA_LOCAL_ROOT = "local", tmp_path
    from apps.media.storage import get_storage

    get_storage.cache_clear()


# ---- lessons ----
def course(w, state="published"):
    return Course.objects.create(title="أساسيات التجويد", topic="tajweed", level="مبتدئ", teacher=w.t1, state=state)


def test_library_lists_only_published_lessons_of_published_courses(world):
    c, hidden = course(world), course(world, state="draft")
    l1 = Lesson.objects.create(course=c, order=1, title="درس 1", state="published", body="نص")
    Lesson.objects.create(course=c, order=2, title="مسودة", state="draft")
    Lesson.objects.create(course=hidden, order=1, title="في دورة غير منشورة", state="published")
    l2 = Lesson.objects.create(course=c, order=3, title="درس 2", state="published")
    s1 = client_for(world.s1)
    rows = s1.get("/api/v1/lessons").json()
    assert [r["title"] for r in rows] == ["درس 1", "درس 2"]
    assert rows[0]["topic_label"] == "التجويد" and "body" not in rows[0]
    d = s1.get(f"/api/v1/lessons/{l1.id}").json()
    assert d["body"] == "نص" and d["next"]["id"] == l2.id
    assert s1.get(f"/api/v1/lessons/{Lesson.objects.get(title='مسودة').id}").status_code == 404
    assert s1.get("/api/v1/lessons?topic=hifz").json() == []


def test_mark_lesson_complete_is_idempotent_and_per_student(world):
    l = Lesson.objects.create(course=course(world), title="درس", state="published")
    s1 = client_for(world.s1)
    assert s1.post(f"/api/v1/lessons/{l.id}/complete").status_code == 200
    assert s1.post(f"/api/v1/lessons/{l.id}/complete").status_code == 200
    assert LessonCompletion.objects.count() == 1
    assert s1.get("/api/v1/lessons").json()[0]["completed"] is True
    assert client_for(world.s2).get("/api/v1/lessons").json()[0]["completed"] is False
    assert client_for(world.t1).post(f"/api/v1/lessons/{l.id}/complete").status_code == 403


# ---- quizzes ----
@pytest.fixture
def quiz(world):
    t = Quiz.objects.create(title="اختبار النون الساكنة", author=world.t1, state="published", duration_minutes=10, max_attempts=2)
    Question.objects.create(test=t, order=1, kind="mcq", prompt="كم عدد حروف الإظهار؟", options=["4", "6"], answer_key=1)
    Question.objects.create(test=t, order=2, kind="true_false", prompt="الإقلاب عند الباء", options=["صح", "خطأ"], answer_key=0)
    Question.objects.create(test=t, order=3, kind="recitation", prompt="سجّل تلاوتك", points=2)
    Question.objects.create(test=t, order=4, kind="mcq", prompt="سؤال قديم", options=["أ", "ب"], answer_key=0, retired=True)
    return t


def qids(t):
    return {q.kind: q.id for q in t.questions.filter(retired=False)}


def rec_upload(c):
    f = SimpleUploadedFile("r.webm", b"\x1a\x45\xdf\xa3" + b"\0" * 500, content_type="audio/webm")
    return c.post("/api/v1/media/recitations", {"file": f, "duration_seconds": 12}, format="multipart").json()["id"]


def test_questions_never_expose_answer_keys(world, quiz):
    s1 = client_for(world.s1)
    lst = s1.get("/api/v1/tests").json()
    assert lst[0]["question_count"] == 3 and lst[0]["has_recitation"] is True
    d = s1.get(f"/api/v1/tests/{quiz.id}").json()
    assert len(d["questions"]) == 3 and all("answer_key" not in q and "correct" not in q for q in d["questions"])


def test_hidden_tests_are_not_listed(world, quiz):
    Quiz.objects.create(title="مسودة", author=world.t1, state="draft")
    Quiz.objects.create(title="مغلق", author=world.t1, state="published", closes_at=timezone.now() - timedelta(days=1))
    Quiz.objects.create(title="لم يُفتح", author=world.t1, state="published", opens_at=timezone.now() + timedelta(days=1))
    assert [t["title"] for t in client_for(world.s1).get("/api/v1/tests").json()] == ["اختبار النون الساكنة"]


def test_attempt_graded_on_server_and_recitation_waits_for_teacher(world, quiz):
    s1, t1 = client_for(world.s1), client_for(world.t1)
    a = s1.post(f"/api/v1/tests/{quiz.id}/attempts").json()
    assert a["status"] == "in_progress" and a["deadline_at"]
    assert s1.post(f"/api/v1/tests/{quiz.id}/attempts").json()["id"] == a["id"]  # resume, not a new attempt
    q = qids(quiz)
    body = {"answers": [{"question": q["mcq"], "response": 1}, {"question": q["true_false"], "response": 1},
                        {"question": q["recitation"], "recording": rec_upload(s1)}]}
    r = s1.post(f"/api/v1/attempts/{a['id']}/submit", body, format="json").json()
    assert r["status"] == "submitted" and r["objective_score"] == 1 and r["objective_max"] == 2 and r["score"] is None
    by_kind = {x["kind"]: x for x in r["answers"]}
    assert by_kind["mcq"]["is_correct"] is True and by_kind["true_false"]["correct"] == 0  # key revealed only after submit
    assert s1.post(f"/api/v1/attempts/{a['id']}/submit", body, format="json").json()["objective_score"] == 1  # idempotent

    pending = t1.get("/api/v1/teacher/grading").json()
    assert len(pending) == 1 and pending[0]["recording"]["url"]
    assert client_for(world.t2).get("/api/v1/teacher/grading").json() == []
    assert client_for(world.t2).post(f"/api/v1/answers/{pending[0]['answer']}/grade", {"points": 2}, format="json").status_code == 404
    assert t1.post(f"/api/v1/answers/{pending[0]['answer']}/grade", {"points": 5}, format="json").status_code == 400
    g = t1.post(f"/api/v1/answers/{pending[0]['answer']}/grade", {"points": 2, "reason": "أحسنت"}, format="json").json()
    assert g["attempt_status"] == "graded"
    final = s1.get(f"/api/v1/attempts/{a['id']}").json()
    assert final["score"] == 3 and final["max"] == 4
    # Parent of s1 can read the result; s2 cannot.
    assert client_for(world.p1).get(f"/api/v1/attempts/{a['id']}").json()["score"] == 3
    assert client_for(world.s2).get(f"/api/v1/attempts/{a['id']}").status_code == 404


def test_attempt_limits_deadline_and_bad_answers(world, quiz):
    s1 = client_for(world.s1)
    q = qids(quiz)
    a1 = s1.post(f"/api/v1/tests/{quiz.id}/attempts").json()
    assert s1.post(f"/api/v1/attempts/{a1['id']}/submit", {"answers": [{"question": 999999, "response": 0}]}, format="json").status_code == 400
    retired = quiz.questions.get(retired=True).id
    assert s1.post(f"/api/v1/attempts/{a1['id']}/submit", {"answers": [{"question": retired, "response": 0}]}, format="json").status_code == 400
    other = rec_upload(client_for(world.s2))
    assert s1.post(f"/api/v1/attempts/{a1['id']}/submit", {"answers": [{"question": q["recitation"], "recording": other}]}, format="json").status_code == 400
    r = s1.post(f"/api/v1/attempts/{a1['id']}/submit", {"answers": []}, format="json").json()
    assert r["status"] == "graded" and r["score"] == 0  # nothing answered: nothing left to grade
    a2 = s1.post(f"/api/v1/tests/{quiz.id}/attempts").json()
    Attempt.objects.filter(pk=a2["id"]).update(deadline_at=timezone.now() - timedelta(minutes=5))
    assert s1.post(f"/api/v1/attempts/{a2['id']}/submit", {"answers": []}, format="json").json()["code"] == "deadline_passed"
    Attempt.objects.filter(pk=a2["id"]).update(status="submitted")
    assert s1.post(f"/api/v1/tests/{quiz.id}/attempts").json()["code"] == "no_attempts_left"
    assert client_for(world.s2).post(f"/api/v1/attempts/{a1['id']}/submit", {"answers": []}, format="json").status_code == 404


def test_quiz_recording_is_deleted_48h_after_grading_never_while_waiting(world, quiz):
    from django.core.management import call_command

    from apps.assessments.models import Answer
    from apps.media.models import MediaObject

    s1, t1 = client_for(world.s1), client_for(world.t1)
    a = s1.post(f"/api/v1/tests/{quiz.id}/attempts").json()
    rec = rec_upload(s1)
    s1.post(f"/api/v1/attempts/{a['id']}/submit", {"answers": [{"question": qids(quiz)["recitation"], "recording": rec}]}, format="json")
    MediaObject.objects.filter(pk=rec).update(created_at=timezone.now() - timedelta(days=30))
    call_command("purge_reviewed_recordings")
    assert MediaObject.objects.get(pk=rec).state == "validated"  # the teacher has not graded it yet
    ans = t1.get("/api/v1/teacher/grading").json()[0]["answer"]
    t1.post(f"/api/v1/answers/{ans}/grade", {"points": 2}, format="json")
    call_command("purge_reviewed_recordings")
    assert MediaObject.objects.get(pk=rec).state == "validated"  # graded just now
    Answer.objects.filter(pk=ans).update(graded_at=timezone.now() - timedelta(hours=49))
    call_command("purge_reviewed_recordings")
    assert MediaObject.objects.get(pk=rec).state == "deleted"
    assert s1.get(f"/api/v1/attempts/{a['id']}").json()["score"] == 2  # the grade stays
