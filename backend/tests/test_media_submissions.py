"""Prompt 13–14: private recordings, submissions and teacher feedback."""
import uuid
from datetime import timedelta

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from rest_framework.test import APIClient

from apps.learning.models import Assignment, AssignmentStatus, Feedback, Submission
from apps.media.models import MediaObject
from apps.notifications.models import Notification

from .conftest import client_for

WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 2000
OGG = b"OggS" + b"\x00" * 2000


@pytest.fixture(autouse=True)
def _private_root(settings, tmp_path):
    settings.MEDIA_STORAGE = "local"
    settings.MEDIA_LOCAL_ROOT = tmp_path / "media"
    from apps.media.storage import get_storage

    get_storage.cache_clear()
    yield
    get_storage.cache_clear()


def upload(c, data=WEBM, ctype="audio/webm", dur=42, path="/api/v1/media/recitations"):
    f = SimpleUploadedFile("rec.webm", data, content_type=ctype)
    return c.post(path, {"file": f, "duration_seconds": dur}, format="multipart")


def assignment(w, student=None, teacher=None, status=AssignmentStatus.IN_PROGRESS):
    return Assignment.objects.create(student=student or w.s1, teacher=teacher or w.t1, kind="hifz", title="حفظ سورة الملك",
                                     surah=67, ayah_from=1, ayah_to=10, due_at=timezone.now() + timedelta(days=1), status=status)


def submit(c, a, media_id, key=None):
    return c.post(f"/api/v1/assignments/{a.pk}/submissions", {"media": media_id}, format="json",
                  HTTP_IDEMPOTENCY_KEY=key or str(uuid.uuid4()))


FB = {"score_hifz": 4, "score_tajweed": 3, "score_fluency": 5, "decision": "accept", "general": "أحسنت",
      "notes": [{"at_seconds": 8, "text": "انتبه للغنة"}, {"at_seconds": 3, "text": "بداية جيدة"}]}


# ---- upload validation ----
def test_upload_validates_type_signature_size_and_duration(world, settings):
    c = client_for(world.s1)
    r = upload(c)
    assert r.status_code == 201, r.content
    m = MediaObject.objects.get(pk=r.json()["id"])
    assert m.state == "validated" and m.size_bytes == len(WEBM) and len(m.sha256) == 64
    assert m.key.startswith(f"recitation/{world.s1.pk}/") and "rec.webm" not in m.key  # server-generated key
    assert (settings.MEDIA_LOCAL_ROOT / m.key).read_bytes() == WEBM

    assert upload(c, data=b"<html>not audio</html>" + b"\x00" * 50).json()["code"] == "invalid_file"  # bytes don't match type
    assert upload(c, ctype="text/html").json()["code"] == "invalid_file"
    assert upload(c, data=OGG, ctype="audio/ogg").status_code == 201
    assert upload(c, dur=0).status_code == 400
    assert upload(c, dur=60 * 60).status_code == 400
    settings.MEDIA_MAX_BYTES = {"recitation": 1000, "voice_feedback": 1000}
    assert upload(c).status_code == 413


def test_only_students_upload_recitations_and_only_teachers_voice_notes(world):
    assert upload(client_for(world.t1)).status_code == 403
    assert upload(client_for(world.p1)).status_code == 403
    assert upload(client_for(world.s1), path="/api/v1/media/voice-feedback").status_code == 403
    assert upload(client_for(world.t1), path="/api/v1/media/voice-feedback").status_code == 201
    assert upload(APIClient()).status_code in (401, 403)


# ---- privacy ----
def test_recording_is_private_until_submitted_and_never_for_parents(world):
    s1, t1, t2, p1 = (client_for(u) for u in (world.s1, world.t1, world.t2, world.p1))
    mid = upload(s1).json()["id"]
    assert s1.get(f"/api/v1/media/{mid}").status_code == 200
    assert t1.get(f"/api/v1/media/{mid}").status_code == 404  # not submitted yet
    submit(s1, assignment(world), mid)
    assert t1.get(f"/api/v1/media/{mid}").status_code == 200  # assigned teacher
    assert t2.get(f"/api/v1/media/{mid}").status_code == 404  # other teacher
    assert p1.get(f"/api/v1/media/{mid}").status_code == 404  # parent: recordings stay private
    assert client_for(world.s2).get(f"/api/v1/media/{mid}").status_code == 404
    assert client_for(world.admin).get(f"/api/v1/media/{mid}").status_code == 200


def test_signed_url_streams_and_rejects_tampering_or_expiry(world, settings):
    s1 = client_for(world.s1)
    mid = upload(s1).json()["id"]
    url = s1.get(f"/api/v1/media/{mid}").json()["url"]
    anon = APIClient()
    r = anon.get(url)
    assert r.status_code == 200 and b"".join(r.streaming_content) == WEBM
    assert r["Cache-Control"] == "private, no-store"
    assert anon.get(url[:-3] + "abc").status_code == 404  # tampered token
    other = upload(s1).json()["id"]
    assert anon.get(url.replace(mid, other)).status_code == 404  # token bound to one file
    settings.MEDIA_URL_TTL_SECONDS = -1
    assert anon.get(url).status_code == 404  # expired


# ---- submissions ----
def test_submit_moves_task_and_is_idempotent(world, django_capture_on_commit_callbacks):
    s1 = client_for(world.s1)
    a = assignment(world)
    mid = upload(s1).json()["id"]
    key = str(uuid.uuid4())
    with django_capture_on_commit_callbacks(execute=True):
        r = submit(s1, a, mid, key)
    assert r.status_code == 201 and r.json()["attempt"] == 1 and r.json()["audio"]["url"]
    assert submit(s1, a, mid, key).status_code == 200  # retried tap: same result, no duplicate
    assert Submission.objects.count() == 1
    a.refresh_from_db()
    assert a.status == "submitted"
    assert Notification.objects.filter(recipient=world.t1, kind="submission_new").count() == 1
    assert submit(s1, a, upload(s1).json()["id"]).json()["code"] == "not_submittable"  # awaiting review


def test_cannot_submit_someone_elses_media_or_task(world):
    s1, s2 = client_for(world.s1), client_for(world.s2)
    a1 = assignment(world)
    other_media = upload(s2).json()["id"]
    assert submit(s1, a1, other_media).status_code == 400
    assert submit(s2, a1, other_media).status_code == 404
    assert s1.post(f"/api/v1/assignments/{a1.pk}/submissions", {"media": upload(s1).json()["id"]}, format="json").status_code == 400  # no key


# ---- feedback ----
def test_teacher_feedback_accept_flow(world, django_capture_on_commit_callbacks):
    s1, t1 = client_for(world.s1), client_for(world.t1)
    a = assignment(world)
    sub = submit(s1, a, upload(s1).json()["id"]).json()
    pending = t1.get("/api/v1/submissions?state=pending").json()
    assert [x["id"] for x in pending["results"]] == [sub["id"]]
    with django_capture_on_commit_callbacks(execute=True):
        r = t1.post(f"/api/v1/submissions/{sub['id']}/feedback", FB, format="json")
    assert r.status_code == 201, r.content
    fb = r.json()["feedback"]
    assert fb["decision"] == "accept" and [n["at_seconds"] for n in fb["notes"]] == [3, 8]
    a.refresh_from_db()
    assert a.status == "accepted"
    assert Notification.objects.filter(recipient=world.s1, kind="feedback_new").exists()
    assert t1.post(f"/api/v1/submissions/{sub['id']}/feedback", FB, format="json").json()["code"] == "already_reviewed"
    mine = s1.get(f"/api/v1/submissions?assignment={a.pk}").json()["results"][0]
    assert mine["feedback"]["score_hifz"] == 4
    # Parent sees the feedback summary but no audio.
    kid = client_for(world.p1).get("/api/v1/submissions").json()["results"][0]
    assert kid["feedback"]["decision"] == "accept" and kid["audio"] is None


def test_repeat_requires_reason_and_reopens_task(world):
    s1, t1 = client_for(world.s1), client_for(world.t1)
    a = assignment(world)
    sub = submit(s1, a, upload(s1).json()["id"]).json()
    bad = t1.post(f"/api/v1/submissions/{sub['id']}/feedback", {**FB, "decision": "repeat"}, format="json")
    assert bad.status_code == 400 and "needs_review" in bad.json()["fields"]
    ok = t1.post(f"/api/v1/submissions/{sub['id']}/feedback", {**FB, "decision": "repeat", "needs_review": "الآيات 6–8"}, format="json")
    assert ok.status_code == 201
    a.refresh_from_db()
    assert a.status == "needs_repeat"
    second = submit(s1, a, upload(s1).json()["id"]).json()
    assert second["attempt"] == 2


def test_only_assigned_teacher_reviews(world):
    s1 = client_for(world.s1)
    sub = submit(s1, assignment(world), upload(s1).json()["id"]).json()
    assert client_for(world.t2).post(f"/api/v1/submissions/{sub['id']}/feedback", FB, format="json").status_code == 404
    assert client_for(world.t2).get("/api/v1/submissions").json()["count"] == 0
    assert s1.post(f"/api/v1/submissions/{sub['id']}/feedback", FB, format="json").status_code == 403
    assert not Feedback.objects.exists()


def test_voice_feedback_visible_to_student_only(world):
    s1, t1 = client_for(world.s1), client_for(world.t1)
    sub = submit(s1, assignment(world), upload(s1).json()["id"]).json()
    voice = upload(t1, dur=20, path="/api/v1/media/voice-feedback").json()["id"]
    assert s1.get(f"/api/v1/media/{voice}").status_code == 404  # not attached yet
    r = t1.post(f"/api/v1/submissions/{sub['id']}/feedback", {**FB, "voice": voice}, format="json")
    assert r.status_code == 201 and r.json()["feedback"]["voice"]["url"]
    assert s1.get(f"/api/v1/media/{voice}").status_code == 200
    assert client_for(world.s2).get(f"/api/v1/media/{voice}").status_code == 404
    assert client_for(world.p1).get(f"/api/v1/media/{voice}").status_code == 404


# ---- S3/R2 backend (offline: no network calls) ----
def test_s3_backend_refuses_missing_credentials_and_presigns(settings):
    from django.core.exceptions import ImproperlyConfigured

    from apps.media.storage import S3Storage

    settings.STORAGE_BUCKET = ""
    with pytest.raises(ImproperlyConfigured):
        S3Storage()
    settings.STORAGE_BUCKET, settings.STORAGE_ACCESS_KEY_ID, settings.STORAGE_SECRET_ACCESS_KEY = "halqa-private", "AKIDEXAMPLE", "secret"
    settings.STORAGE_ENDPOINT_URL, settings.MEDIA_URL_TTL_SECONDS = "https://acct.r2.cloudflarestorage.com", 300
    url, _ = S3Storage().read_url("recitation/1/x.webm", media_id="x")
    assert url.startswith("https://acct.r2.cloudflarestorage.com/halqa-private/recitation/1/x.webm?")
    assert "X-Amz-Expires=300" in url and "X-Amz-Signature=" in url


def test_purge_orphan_media_keeps_submitted(world, settings):
    from django.core.management import call_command

    s1 = client_for(world.s1)
    kept = upload(s1).json()["id"]
    submit(s1, assignment(world), kept)
    orphan = upload(s1).json()["id"]
    MediaObject.objects.update(created_at=timezone.now() - timedelta(days=3))
    call_command("purge_orphan_media")
    assert MediaObject.objects.get(pk=orphan).state == "deleted"
    assert not (settings.MEDIA_LOCAL_ROOT / MediaObject.objects.get(pk=orphan).key).exists()
    assert MediaObject.objects.get(pk=kept).state == "validated"


def test_storage_provider_failure_is_reported_and_nothing_is_claimed(world, monkeypatch):
    """Pack prompt 22: a provider outage returns an honest Arabic 503; the media is not usable for a submission."""
    from apps.media import storage

    class Down:
        def save(self, *a, **k):
            raise storage.StorageError("connection reset")

    monkeypatch.setattr("apps.media.services.get_storage", lambda: Down())
    s1 = client_for(world.s1)
    r = upload(s1)
    assert r.status_code == 503 and r.json()["code"] == "storage_unavailable" and "حاول" in r.json()["message"]
    m = MediaObject.objects.get(owner=world.s1)
    assert m.state == MediaObject.State.REJECTED
    a = assignment(world)
    assert submit(s1, a, str(m.id)).status_code == 400  # a rejected upload can never be submitted
    a.refresh_from_db()
    assert a.status == "in_progress" and not Submission.objects.exists()


def test_teacher_plays_submitted_recording_parent_and_strangers_cannot(world):
    s1 = client_for(world.s1)
    a = assignment(world)
    mid = upload(s1).json()["id"]
    submit(s1, a, mid)
    assert client_for(world.t1).get(f"/api/v1/media/{mid}").json()["url"]  # assigned teacher: short-lived link
    for u in (world.p1, world.t2, world.s2):
        assert client_for(u).get(f"/api/v1/media/{mid}").status_code == 404
    assert APIClient().get(f"/api/v1/media/{mid}").status_code in (401, 403)
