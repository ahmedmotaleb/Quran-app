"""Real-device recording failure (22 October 2026): uploads succeeded but the submit went to
`assignments/NaN/submissions` and got Django's HTML 404. Covers: JSON errors for every /api/ path, per-format
signature checks with real container headers, and retry-safe uploads (X-Upload-ID)."""
import uuid
from datetime import timedelta

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone

from apps.learning.models import Assignment, AssignmentStatus
from apps.media.models import MediaObject

from .conftest import client_for

pytestmark = pytest.mark.django_db
URL = "/api/v1/media/recitations"
# First bytes as produced by real recorders (padding stands in for the audio frames).
WEBM = b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\xf7\x81\x01\x42\xf2\x81\x04webm" + b"\x00" * 3000   # Chrome / Android
M4A = b"\x00\x00\x00\x1cftypM4A \x00\x00\x00\x00M4A isommp42" + b"\x00" * 3000                   # Safari / iPhone
MP4 = b"\x00\x00\x00\x18ftypiso5\x00\x00\x02\x00iso5mp41" + b"\x00" * 3000                        # Chrome audio/mp4
OGG = b"OggS\x00\x02" + b"\x00" * 3000                                                              # Firefox
AAC = b"\xff\xf1\x50\x80\x02\x1f\xfc" + b"\x00" * 3000


@pytest.fixture(autouse=True)
def _private_root(settings, tmp_path):
    settings.MEDIA_STORAGE = "local"
    settings.MEDIA_LOCAL_ROOT = tmp_path / "media"
    from apps.media.storage import get_storage

    get_storage.cache_clear()
    yield
    get_storage.cache_clear()


def up(c, data, ctype, name="recitation.bin", key=None, dur=25):
    extra = {"HTTP_X_UPLOAD_ID": key} if key else {}
    return c.post(URL, {"file": SimpleUploadedFile(name, data, content_type=ctype), "duration_seconds": dur}, format="multipart", **extra)


@pytest.mark.parametrize("data,ctype,ext", [
    (WEBM, "audio/webm", "webm"), (WEBM, "audio/webm;codecs=opus", "webm"), (M4A, "audio/mp4", "m4a"),
    (MP4, "audio/mp4", "m4a"), (M4A, "audio/x-m4a", "m4a"), (OGG, "audio/ogg;codecs=opus", "ogg"), (AAC, "audio/aac", "aac"),
])
def test_real_recorder_formats_are_accepted(world, data, ctype, ext):
    r = up(client_for(world.s1), data, ctype)
    assert r.status_code == 201, r.json()
    m = MediaObject.objects.get(pk=r.json()["id"])
    assert m.state == "validated" and m.key.endswith("." + ext) and m.content_type == ctype.split(";")[0]


@pytest.mark.parametrize("data,ctype,code", [
    (WEBM, "audio/mp4", "invalid_file"),          # MP4 label on WebM bytes
    (M4A, "audio/webm", "invalid_file"),          # WebM label on MP4 bytes
    (b"<html>" + b"\x00" * 3000, "audio/webm", "invalid_file"),
    (WEBM, "audio/flac", "invalid_file"),         # a type the server does not accept
    (WEBM, "application/octet-stream", "invalid_file"),
])
def test_fake_or_mismatched_types_are_refused(world, data, ctype, code):
    r = up(client_for(world.s1), data, ctype)
    assert r.status_code == 400 and r.json()["code"] == code and not MediaObject.objects.exists()


def test_empty_and_oversized_files(world, settings):
    c = client_for(world.s1)
    assert up(c, b"", "audio/webm").json()["code"] in ("empty_file", "invalid")
    settings.MEDIA_MAX_BYTES = {**settings.MEDIA_MAX_BYTES, "recitation": 2000}
    r = up(c, WEBM, "audio/webm")
    assert r.status_code == 413 and r.json()["code"] == "file_too_large"


def test_same_upload_id_returns_the_same_object(world):
    c = client_for(world.s1)
    key = str(uuid.uuid4())
    first = up(c, WEBM, "audio/webm", key=key)
    again = up(c, WEBM, "audio/webm", key=key)
    assert first.status_code == 201 and again.status_code == 200 and again.json()["id"] == first.json()["id"]
    assert MediaObject.objects.count() == 1
    # The key belongs to this student only; another student's same key is a different upload.
    other = up(client_for(world.s2), WEBM, "audio/webm", key=key)
    assert other.status_code == 201 and other.json()["id"] != first.json()["id"]
    assert up(c, WEBM, "audio/webm", key="bad key!").status_code == 400


def test_storage_failure_is_json_503_and_the_same_upload_id_can_retry(world, monkeypatch):
    from apps.media import storage

    real = storage.get_storage()

    class Down:
        def save(self, *a, **k):
            raise storage.StorageError("timeout")

    monkeypatch.setattr("apps.media.services.get_storage", lambda: Down())
    c, key = client_for(world.s1), str(uuid.uuid4())
    r = up(c, WEBM, "audio/webm", key=key)
    assert r.status_code == 503 and r.json()["code"] == "storage_unavailable" and r["Content-Type"].startswith("application/json")
    monkeypatch.setattr("apps.media.services.get_storage", lambda: real)
    ok = up(c, WEBM, "audio/webm", key=key)
    assert ok.status_code == 201
    assert MediaObject.objects.filter(state="validated").count() == 1


def test_malformed_api_urls_answer_json_not_html(world):
    c = client_for(world.s1)
    r = c.post("/api/v1/assignments/NaN/submissions", {"media": "x"}, format="json")
    assert r.status_code == 404 and r["Content-Type"].startswith("application/json")
    assert r.json()["code"] == "not_found" and "request_id" in r.json()
    assert c.get("/api/v1/no-such-endpoint").json()["code"] == "not_found"


def test_full_flow_upload_retry_then_submit(world):
    a = Assignment.objects.create(student=world.s1, teacher=world.t1, kind="hifz", title="حفظ", surah=67, ayah_from=1,
                                  ayah_to=5, due_at=timezone.now() + timedelta(days=1), status=AssignmentStatus.IN_PROGRESS)
    c, key = client_for(world.s1), str(uuid.uuid4())
    mid = up(c, WEBM, "audio/webm;codecs=opus", key=key).json()["id"]
    assert up(c, WEBM, "audio/webm;codecs=opus", key=key).json()["id"] == mid  # the retry after a lost response
    r = c.post(f"/api/v1/assignments/{a.pk}/submissions", {"media": mid}, format="json", HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
    assert r.status_code == 201
    assert client_for(world.t1).get(f"/api/v1/media/{mid}").json()["url"]
