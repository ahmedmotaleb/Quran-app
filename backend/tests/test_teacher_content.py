"""Teacher content authoring: teachers draft, admins publish, students use, published content stays stable."""
import pytest

from apps.learning.models import Course

from .conftest import client_for

pytestmark = pytest.mark.django_db

LESSON = {"title": "مخارج الحروف", "kind": "text", "body": "شرح مختصر لمخارج الحروف.", "duration_minutes": 12}
QUIZ = {"title": "اختبار المخارج", "topic": "tajweed", "duration_minutes": 10, "questions": [
    {"kind": "mcq", "prompt": "كم عدد مخارج الحروف؟", "options": ["17", "5", "29"], "answer_key": 0},
    {"kind": "true_false", "prompt": "الحلق من مخارج الحروف", "answer_key": True},
    {"kind": "recitation", "prompt": "سجّل أول سورة الملك", "options": {"surah": 67, "ayah_from": 1, "ayah_to": 4}, "points": 2},
]}


def test_teacher_drafts_admin_publishes_student_sees(world):
    t1, admin, s1 = client_for(world.t1), client_for(world.admin), client_for(world.s1)
    c = t1.post("/api/v1/teacher/courses", {"title": "التجويد للمبتدئين", "topic": "tajweed", "restricted": True}, format="json")
    assert c.status_code == 201 and c.json()["state"] == "draft" and c.json()["teacher"]["id"] == world.t1.id
    assert c.json()["restricted"] is False  # access rules are not the teacher's call
    cid = c.json()["id"]
    l = t1.post(f"/api/v1/teacher/courses/{cid}/lessons", LESSON, format="json")
    assert l.status_code == 201 and l.json()["state"] == "draft"
    q = t1.post("/api/v1/teacher/tests", {**QUIZ, "course": cid}, format="json")
    assert q.status_code == 201 and q.json()["state"] == "draft" and q.json()["questions"] == 3

    # Nothing reaches students before an admin publishes.
    assert all(x["title"] != LESSON["title"] for x in s1.get("/api/v1/lessons").json())
    drafts = admin.get("/api/v1/admin/content/drafts").json()
    assert drafts["lessons_by_teachers"] == 1 and drafts["tests_by_teachers"] == 1
    mine = t1.get("/api/v1/teacher/content").json()
    assert [x["title"] for x in mine["courses"][0]["lesson_list"]] == [LESSON["title"]] and mine["tests"][0]["title"] == QUIZ["title"]

    # Admin reviews and publishes; the student can now study and attempt it.
    assert admin.post(f"/api/v1/admin/lessons/{l.json()['id']}/state", {"state": "published"}, format="json").status_code == 200
    assert admin.post(f"/api/v1/admin/courses/{cid}/state", {"state": "published"}, format="json").status_code == 200
    assert admin.post(f"/api/v1/admin/tests/{q.json()['id']}/state", {"state": "published"}, format="json").status_code == 200
    assert any(x["title"] == LESSON["title"] for x in s1.get("/api/v1/lessons").json())
    assert s1.post(f"/api/v1/tests/{q.json()['id']}/attempts").status_code in (200, 201)

    # Published content is locked for the teacher (admins edit it, keeping history safe).
    r = t1.patch(f"/api/v1/teacher/lessons/{l.json()['id']}", {"title": "عنوان آخر"}, format="json")
    assert r.status_code == 409 and r.json()["code"] == "published_locked"
    assert t1.delete(f"/api/v1/teacher/tests/{q.json()['id']}").status_code == 409


def test_drafts_can_be_edited_and_deleted(world):
    t1 = client_for(world.t1)
    cid = t1.post("/api/v1/teacher/courses", {"title": "دورة الحفظ"}, format="json").json()["id"]
    lid = t1.post(f"/api/v1/teacher/courses/{cid}/lessons", LESSON, format="json").json()["id"]
    assert t1.patch(f"/api/v1/teacher/lessons/{lid}", {"title": "مخارج الحروف (منقح)"}, format="json").json()["title"] == "مخارج الحروف (منقح)"
    assert t1.delete(f"/api/v1/teacher/lessons/{lid}").status_code == 204
    qid = t1.post("/api/v1/teacher/tests", QUIZ, format="json").json()["id"]
    assert t1.delete(f"/api/v1/teacher/tests/{qid}").status_code == 204


def test_validation_is_the_same_as_the_admin_console(world):
    t1 = client_for(world.t1)
    cid = t1.post("/api/v1/teacher/courses", {"title": "دورة"}, format="json").json()["id"]
    bad_video = t1.post(f"/api/v1/teacher/courses/{cid}/lessons", {"title": "فيديو", "kind": "video", "external_url": "https://evil.example/x"}, format="json")
    assert bad_video.status_code == 400 and "external_url" in bad_video.json()["fields"]
    bad_range = {**QUIZ, "questions": [{"kind": "recitation", "prompt": "سجّل الآيات", "options": {"surah": 1, "ayah_from": 1, "ayah_to": 9}}]}
    r = t1.post("/api/v1/teacher/tests", bad_range, format="json")
    assert r.status_code == 400 and "questions" in r.json()["fields"]
    assert t1.post("/api/v1/teacher/tests", {**QUIZ, "questions": []}, format="json").status_code == 400
    assert not t1.get("/api/v1/teacher/content").json()["tests"]  # nothing half-saved


def test_teachers_only_touch_their_own_content(world):
    t1, t2 = client_for(world.t1), client_for(world.t2)
    cid = t1.post("/api/v1/teacher/courses", {"title": "دورة المعلم الأول"}, format="json").json()["id"]
    lid = t1.post(f"/api/v1/teacher/courses/{cid}/lessons", LESSON, format="json").json()["id"]
    qid = t1.post("/api/v1/teacher/tests", QUIZ, format="json").json()["id"]
    assert t2.post(f"/api/v1/teacher/courses/{cid}/lessons", LESSON, format="json").status_code == 404
    assert t2.patch(f"/api/v1/teacher/lessons/{lid}", {"title": "x y z"}, format="json").status_code == 404
    assert t2.delete(f"/api/v1/teacher/tests/{qid}").status_code == 404
    assert t2.post("/api/v1/teacher/tests", {**QUIZ, "course": cid}, format="json").status_code == 400
    assert t2.get("/api/v1/teacher/content").json() == {"courses": [], "tests": [], "rule": t2.get("/api/v1/teacher/content").json()["rule"]}
    for who in (world.s1, world.p1):
        c = client_for(who)
        assert c.get("/api/v1/teacher/content").status_code == 403
        assert c.post("/api/v1/teacher/courses", {"title": "x y"}, format="json").status_code == 403
    assert client_for(world.t1).get("/api/v1/admin/content/drafts").status_code == 403
    assert Course.objects.get(pk=cid).teacher_id == world.t1.id


# ---- lesson files (PDF / audio) -------------------------------------------------------
from django.core.files.uploadedfile import SimpleUploadedFile  # noqa: E402

from .test_media_submissions import _private_root  # noqa: E402,F401 (uploads go to a temporary folder)

PDF = b"%PDF-1.4\n" + b"0" * 2000
MP3 = b"ID3" + b"\0" * 3000


def lesson_file(c, data=PDF, ctype="application/pdf", **extra):
    return c.post("/api/v1/media/lesson-files", {"file": SimpleUploadedFile("f", data, content_type=ctype), **extra}, format="multipart")


def test_lesson_files_upload_attach_and_read_rules(world):
    t1, admin, s1, p1 = client_for(world.t1), client_for(world.admin), client_for(world.s1), client_for(world.p1)
    assert lesson_file(s1).status_code == 403 and lesson_file(p1).status_code == 403   # students/parents cannot upload
    assert lesson_file(t1, b"not a pdf at all", "application/pdf").status_code == 400  # signature checked
    assert lesson_file(t1, PDF, "application/zip").status_code == 400
    pdf = lesson_file(t1).json()
    mp3 = lesson_file(t1, MP3, "audio/mpeg", duration_seconds="600").json()
    assert pdf["content_type"] == "application/pdf" and pdf["duration_seconds"] is None

    cid = t1.post("/api/v1/teacher/courses", {"title": "دورة الملفات"}, format="json").json()["id"]
    assert t1.post(f"/api/v1/teacher/courses/{cid}/lessons", {"title": "ملخص", "kind": "pdf"}, format="json").status_code == 400  # file required
    wrong = t1.post(f"/api/v1/teacher/courses/{cid}/lessons", {"title": "ملخص", "kind": "pdf", "media": mp3["id"]}, format="json")
    assert wrong.status_code == 400 and "media" in wrong.json()["fields"]                  # audio is not a PDF
    other = lesson_file(client_for(world.t2)).json()
    assert t1.post(f"/api/v1/teacher/courses/{cid}/lessons", {"title": "ملخص", "kind": "pdf", "media": other["id"]}, format="json").status_code == 400
    l = t1.post(f"/api/v1/teacher/courses/{cid}/lessons", {"title": "ملخص", "kind": "pdf", "media": pdf["id"]}, format="json").json()
    assert l["has_file"] and l["file_type"] == "application/pdf"
    assert t1.post(f"/api/v1/teacher/courses/{cid}/lessons", {"title": "نسخة", "kind": "pdf", "media": pdf["id"]}, format="json").status_code == 400  # one lesson per file
    audio = t1.post(f"/api/v1/teacher/courses/{cid}/lessons", {"title": "تلاوة نموذجية", "kind": "audio", "media": mp3["id"]}, format="json")
    assert audio.status_code == 201

    # Draft: the student cannot read the file. Published: they can, through a signed link; parents never.
    assert s1.get(f"/api/v1/media/{pdf['id']}").status_code == 404
    admin.post(f"/api/v1/admin/lessons/{l['id']}/state", {"state": "published"}, format="json")
    admin.post(f"/api/v1/admin/courses/{cid}/state", {"state": "published"}, format="json")
    got = s1.get(f"/api/v1/lessons/{l['id']}").json()
    assert got["kind"] == "pdf" and got["media"]["url"]
    assert s1.get(f"/api/v1/media/{pdf['id']}").status_code == 200
    assert p1.get(f"/api/v1/media/{mp3['id']}").status_code == 404


def test_unattached_lesson_files_are_purged_attached_kept(world):
    from datetime import timedelta

    from django.core.management import call_command
    from django.utils import timezone

    from apps.media.models import MediaObject

    t1 = client_for(world.t1)
    kept, loose = lesson_file(t1).json()["id"], lesson_file(t1).json()["id"]
    cid = t1.post("/api/v1/teacher/courses", {"title": "دورة"}, format="json").json()["id"]
    t1.post(f"/api/v1/teacher/courses/{cid}/lessons", {"title": "ملخص", "kind": "pdf", "media": kept}, format="json")
    MediaObject.objects.filter(pk__in=[kept, loose]).update(created_at=timezone.now() - timedelta(hours=72))
    call_command("purge_orphan_media")
    assert MediaObject.objects.get(pk=kept).state == "validated" and MediaObject.objects.get(pk=loose).state == "deleted"
