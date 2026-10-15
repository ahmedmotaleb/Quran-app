"""Admin portal: courses, lessons, enrollments and quizzes (pack prompt 07)."""
import pytest

from apps.assessments.models import Answer, Question
from apps.learning.models import LessonCompletion

from .conftest import client_for

pytestmark = pytest.mark.django_db
A = "/api/v1/admin"


def _course(c, t, **kw):
    r = c.post(f"{A}/courses", {"title": "أحكام النون الساكنة", "teacher": t.id, "topic": "tajweed", "level": "مبتدئ", **kw}, format="json")
    assert r.status_code == 201, r.json()
    return r.json()


def _lesson(c, cid, **kw):
    r = c.post(f"{A}/courses/{cid}/lessons", {"title": "الإظهار", "kind": "text", "body": "نص الدرس", **kw}, format="json")
    assert r.status_code == 201, r.json()
    return r.json()


def test_content_endpoints_refuse_other_roles(world):
    for who in (world.s1, world.t1, world.p1):
        c = client_for(who)
        for m, url in [("get", f"{A}/courses"), ("post", f"{A}/courses"), ("get", f"{A}/tests"), ("post", f"{A}/tests"),
                       ("post", f"{A}/courses/1/lessons"), ("patch", f"{A}/lessons/1"), ("post", f"{A}/questions/1"),
                       ("post", f"{A}/courses/1/enrollments")]:
            assert getattr(c, m)(url, {}, format="json").status_code in (403, 405), (who.email, url)
            if m != "post" or "questions" not in url:
                assert getattr(c, m)(url, {}, format="json").status_code == 403


def test_course_lifecycle_and_learner_visibility(world):
    c = client_for(world.admin)
    co = _course(c, world.t1)
    le = _lesson(c, co["id"])
    lessons = lambda u: [x["id"] for x in client_for(u).get("/api/v1/lessons").json()]  # noqa: E731
    assert le["id"] not in lessons(world.s1)  # draft course, draft lesson
    assert c.post(f"{A}/courses/{co['id']}/state", {"state": "published"}, format="json").json()["code"] == "no_published_lessons"
    assert c.post(f"{A}/lessons/{le['id']}/state", {"state": "published"}, format="json").status_code == 200
    assert c.post(f"{A}/courses/{co['id']}/state", {"state": "published"}, format="json").json()["state"] == "published"
    assert le["id"] in lessons(world.s1)
    # Cannot unpublish the last published lesson of a published course.
    assert c.post(f"{A}/lessons/{le['id']}/state", {"state": "draft"}, format="json").json()["code"] == "last_published_lesson"
    # A student completes it; archiving keeps the record and hides the course.
    assert client_for(world.s1).post(f"/api/v1/lessons/{le['id']}/complete").status_code == 200
    assert c.post(f"{A}/courses/{co['id']}/state", {"state": "archived"}, format="json").status_code == 400  # reason
    assert c.post(f"{A}/courses/{co['id']}/state", {"state": "archived", "reason": "نهاية الفصل"}, format="json").status_code == 200
    assert le["id"] not in lessons(world.s1)
    assert client_for(world.s1).get(f"/api/v1/lessons/{le['id']}").status_code == 404
    assert LessonCompletion.objects.filter(lesson_id=le["id"], student=world.s1).exists()


def test_video_links_are_validated(world):
    c = client_for(world.admin)
    co = _course(c, world.t1)
    bad = c.post(f"{A}/courses/{co['id']}/lessons", {"title": "فيديو", "kind": "video", "external_url": "https://evil.example/x"}, format="json")
    assert bad.status_code == 400 and "external_url" in bad.json()["fields"]
    assert c.post(f"{A}/courses/{co['id']}/lessons", {"title": "فيديو", "kind": "video"}, format="json").status_code == 400
    ok = c.post(f"{A}/courses/{co['id']}/lessons", {"title": "فيديو", "kind": "video", "external_url": "https://www.youtube.com/watch?v=abc"}, format="json")
    assert ok.status_code == 201
    assert c.post(f"{A}/courses/{co['id']}/lessons", {"title": "نص", "kind": "text", "body": "   "}, format="json").status_code == 400


def test_restricted_course_needs_enrollment(world):
    c = client_for(world.admin)
    co = _course(c, world.t1, restricted=True)
    le = _lesson(c, co["id"])
    c.post(f"{A}/lessons/{le['id']}/state", {"state": "published"}, format="json")
    c.post(f"{A}/courses/{co['id']}/state", {"state": "published"}, format="json")
    assert client_for(world.s1).get(f"/api/v1/lessons/{le['id']}").status_code == 404
    e = c.post(f"{A}/courses/{co['id']}/enrollments", {"student": world.s1.id}, format="json")
    assert e.status_code == 201
    assert c.post(f"{A}/courses/{co['id']}/enrollments", {"student": world.s1.id}, format="json").status_code == 409
    assert c.post(f"{A}/courses/{co['id']}/enrollments", {"student": world.t2.id}, format="json").status_code == 404
    assert client_for(world.s1).get(f"/api/v1/lessons/{le['id']}").status_code == 200
    assert client_for(world.s2).get(f"/api/v1/lessons/{le['id']}").status_code == 404  # another student
    assert client_for(world.t1).get(f"/api/v1/lessons/{le['id']}").status_code == 200  # its teacher
    assert c.post(f"{A}/enrollments/{e.json()['id']}/end", {"status": "withdrawn"}, format="json").json()["status"] == "withdrawn"
    assert client_for(world.s1).get(f"/api/v1/lessons/{le['id']}").status_code == 404
    assert c.get(f"{A}/courses/{co['id']}/enrollments").json()["count"] == 1  # history kept


def _test(c, **kw):
    r = c.post(f"{A}/tests", {"title": "اختبار التجويد", "level": "مبتدئ", "max_attempts": 2, **kw}, format="json")
    assert r.status_code == 201, r.json()
    return r.json()


def test_question_validation_and_quran_reference(world):
    c = client_for(world.admin)
    t = _test(c)
    q = lambda **d: c.post(f"{A}/tests/{t['id']}/questions", d, format="json")  # noqa: E731
    assert q(kind="mcq", prompt="ما حكم النون؟", options=["إظهار"], answer_key=0).status_code == 400
    assert q(kind="mcq", prompt="ما حكم النون؟", options=["إظهار", "إدغام"], answer_key=5).status_code == 400
    assert q(kind="true_false", prompt="الإظهار حلقي", answer_key="yes").status_code == 400
    assert q(kind="recitation", prompt="اقرأ", options={"surah": 1, "ayah_from": 1, "ayah_to": 8}).status_code == 400  # Al-Fatiha has 7
    assert q(kind="recitation", prompt="اقرأ", options={"surah": 115, "ayah_from": 1, "ayah_to": 1}).status_code == 400
    r = q(kind="recitation", prompt="اقرأ الفاتحة", options={"surah": 1, "ayah_from": 1, "ayah_to": 7}, points=5)
    assert r.status_code == 201 and r.json()["options"] == {"surah": 1, "ayah_from": 1, "ayah_to": 7}
    assert q(kind="mcq", prompt="ما حكم النون عند الحاء؟", options=["إظهار", "إخفاء"], answer_key=0).status_code == 201


def test_publish_attempt_then_edit_keeps_history(world):
    c = client_for(world.admin)
    t = _test(c)
    assert c.post(f"{A}/tests/{t['id']}/state", {"state": "published"}, format="json").json()["code"] == "no_questions"
    q1 = c.post(f"{A}/tests/{t['id']}/questions", {"kind": "mcq", "prompt": "حكم النون عند الحاء؟", "options": ["إظهار", "إخفاء"], "answer_key": 0}, format="json").json()
    c.post(f"{A}/tests/{t['id']}/state", {"state": "published"}, format="json")
    s = client_for(world.s1)
    assert t["id"] in [x["id"] for x in s.get("/api/v1/tests").json()]
    att = s.post(f"/api/v1/tests/{t['id']}/attempts").json()
    # Admin edits the question while the attempt is in progress → a new version; the student's answer still counts.
    e = c.patch(f"{A}/questions/{q1['id']}", {"prompt": "ما حكم النون الساكنة عند الحاء؟"}, format="json").json()
    assert e["id"] != q1["id"] and e["version"] == 2
    assert [x["id"] for x in s.get(f"/api/v1/tests/{t['id']}").json()["questions"]] == [q1["id"]]  # in-progress view unchanged
    sub = s.post(f"/api/v1/attempts/{att['id']}/submit", {"answers": [{"question": q1["id"], "response": 0}]}, format="json")
    assert sub.status_code == 200 and sub.json()["objective_score"] == 1
    old = Question.objects.get(pk=q1["id"])
    assert old.retired and old.prompt == "حكم النون عند الحاء؟"  # exact content of the answered version kept
    assert Answer.objects.filter(question=old).count() == 1
    # The next attempt gets the new version.
    att2 = s.post(f"/api/v1/tests/{t['id']}/attempts").json()
    assert [x["id"] for x in s.get(f"/api/v1/tests/{t['id']}").json()["questions"]] == [e["id"]]
    assert s.post(f"/api/v1/attempts/{att2['id']}/submit", {"answers": [{"question": q1["id"], "response": 0}]}, format="json").status_code == 400
    # Removing retires; the admin list shows only live questions.
    assert c.delete(f"{A}/questions/{e['id']}").json()["code"] == "last_question"
    c.post(f"{A}/tests/{t['id']}/state", {"state": "closed"}, format="json")
    assert t["id"] not in [x["id"] for x in s.get("/api/v1/tests").json()]
    detail = c.get(f"{A}/tests/{t['id']}").json()
    assert detail["attempts"] >= 1 and [x["id"] for x in detail["question_list"]] == [e["id"]]


def test_edit_unused_question_in_place(world):
    c = client_for(world.admin)
    t = _test(c)
    q = c.post(f"{A}/tests/{t['id']}/questions", {"kind": "true_false", "prompt": "الإقلاب قبل الباء", "answer_key": True}, format="json").json()
    e = c.patch(f"{A}/questions/{q['id']}", {"points": 3}, format="json").json()
    assert e["id"] == q["id"] and e["points"] == 3 and e["version"] == 1


def test_restricted_course_test_only_for_enrolled(world):
    c = client_for(world.admin)
    co = _course(c, world.t1, restricted=True)
    le = _lesson(c, co["id"])
    c.post(f"{A}/lessons/{le['id']}/state", {"state": "published"}, format="json")
    c.post(f"{A}/courses/{co['id']}/state", {"state": "published"}, format="json")
    t = _test(c, course=co["id"])
    c.post(f"{A}/tests/{t['id']}/questions", {"kind": "true_false", "prompt": "سؤال", "answer_key": True}, format="json")
    c.post(f"{A}/tests/{t['id']}/state", {"state": "published"}, format="json")
    assert t["id"] not in [x["id"] for x in client_for(world.s1).get("/api/v1/tests").json()]
    assert client_for(world.s1).post(f"/api/v1/tests/{t['id']}/attempts").status_code == 404
    c.post(f"{A}/courses/{co['id']}/enrollments", {"student": world.s1.id}, format="json")
    assert t["id"] in [x["id"] for x in client_for(world.s1).get("/api/v1/tests").json()]
