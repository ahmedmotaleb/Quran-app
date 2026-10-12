import pytest


@pytest.mark.django_db
def test_health_and_ready(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    assert "X-Request-ID" in r
    r = client.get("/api/ready")
    assert r.status_code == 200
    assert r.json()["checks"] == {"database": "ok", "migrations": "ok"}


@pytest.mark.django_db
def test_errors_are_arabic_with_request_id(client):
    r = client.get("/api/v1/me", HTTP_X_REQUEST_ID="test-req-12345")
    assert r.status_code in (401, 403)
    body = r.json()
    assert body["code"] == "not_authenticated" and "تسجيل الدخول" in body["message"]
    assert body["request_id"] == "test-req-12345" and r["X-Request-ID"] == "test-req-12345"


@pytest.mark.django_db
def test_ready_reports_unconfigured_features(client, settings):
    settings.MEDIA_STORAGE = "none"
    f = client.get("/api/ready").json()["features"]
    assert f == {"media_storage": "not_configured", "email": "log_only", "quran_text": "not_imported"}


@pytest.mark.django_db
def test_upload_without_storage_fails_honestly(world, settings):
    from django.core.files.uploadedfile import SimpleUploadedFile

    from apps.media.models import MediaObject

    from .conftest import client_for

    settings.MEDIA_STORAGE = "none"
    f = SimpleUploadedFile("r.webm", b"\\x1a\\x45\\xdf\\xa3" + b"\\0" * 100, content_type="audio/webm")
    r = client_for(world.s1).post("/api/v1/media/recitations", {"file": f, "duration_seconds": 5}, format="multipart")
    assert r.status_code == 503 and r.json()["code"] == "storage_not_configured"
    assert not MediaObject.objects.exists()


def test_spa_cache_headers():
    from apps.core.spa import cache_headers

    h = {}
    cache_headers(h, "", "/sw.js")
    assert h["Cache-Control"] == "no-cache"
    h = {}
    cache_headers(h, "", "/assets/index-bFFAwA91.js")
    assert "immutable" in h["Cache-Control"]


def test_db_problem_categories_never_echo_secrets():
    from apps.core.views import _db_problem

    assert _db_problem('FATAL: password authentication failed for user "neondb_owner"') == "wrong password or user in DATABASE_URL"
    assert "neondb_owner" not in _db_problem('FATAL: password authentication failed for user "neondb_owner"')
    assert _db_problem('could not translate host name "ep-x.neon.tech"') == "unknown host in DATABASE_URL"
    assert _db_problem("connection timeout expired") .startswith("connection timed out")
    assert _db_problem("something else") == "cannot connect"


def test_health_answers_platform_checks_on_internal_host(client, settings):
    # Render's health checker uses the container's internal address over plain HTTP.
    settings.ALLOWED_HOSTS = ["halqa-xzum.onrender.com"]
    settings.SECURE_SSL_REDIRECT = True
    r = client.get("/api/health", HTTP_HOST="10.0.0.5:10000")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    # Other endpoints keep host validation.
    assert client.get("/api/ready", HTTP_HOST="10.0.0.5:10000").status_code == 400
