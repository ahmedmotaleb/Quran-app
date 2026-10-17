import pytest

from .test_media_submissions import _private_root  # noqa: F401 (uploads go to a temporary folder)


@pytest.mark.django_db
def test_health_and_ready(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    assert "X-Request-ID" in r
    r = client.get("/api/ready")
    assert r.status_code == 200
    assert r.json()["checks"] == {"database": "ok", "migrations": "ok", "cache": "ok"}


@pytest.mark.django_db
def test_ready_fails_without_the_shared_cache_table(client, caplog, monkeypatch):
    from django.core.cache import cache
    from django.db import connection

    def missing_table(*a, **k):  # what DatabaseCache does when `createcachetable` never ran
        with connection.cursor() as c:
            c.execute("SELECT 1 FROM no_such_cache_table")

    monkeypatch.setattr(cache, "get", missing_table)
    r = client.get("/api/ready")
    assert r.status_code == 503 and r.json()["checks"]["cache"].startswith("unavailable")
    assert r.json()["checks"]["database"] == "ok"  # the failed query did not break the rest of the check
    assert any(rec.msg == "ready_check_failed" for rec in caplog.records)


@pytest.mark.django_db
def test_monitoring_events_are_logged_without_personal_data(world, client, caplog, settings):
    import logging

    from django.core.management import call_command

    settings.LOGIN_LOCKOUT_FAILURES = 2
    caplog.set_level(logging.INFO)
    for _ in range(2):
        client.post("/api/v1/auth/login", {"email": "s1@x.test", "password": "wrong"}, format="json")
    call_command("run_scheduled")
    call_command("emit_test_alert")
    msgs = [r.msg for r in caplog.records]
    assert msgs.count("login_failed") == 2 and "auth_locked" in msgs and "ops_stats" in msgs
    stats = next(r for r in caplog.records if r.msg == "ops_stats")
    assert stats.db_size_mb > 0 and stats.db_connections >= 1
    synthetic = [r for r in caplog.records if getattr(r, "synthetic", False)]
    assert {r.msg for r in synthetic} >= {"media_store_failed", "ready_check_failed", "scheduled_step_failed", "unhandled_error"}
    text = " ".join(str(vars(r)) for r in caplog.records if r.msg in ("login_failed", "auth_locked", "ops_stats"))
    assert "s1@x.test" not in text and "x.test" not in text


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
    assert f == {"media_storage": "not_configured", "email": "log_only", "push": "not_configured", "ayah_audio": "off", "quran_text": "not_imported"}


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
    # Platform health checkers use the container's internal address over plain HTTP.
    settings.ALLOWED_HOSTS = ["halqa-123.europe-west1.run.app"]
    settings.SECURE_SSL_REDIRECT = True
    r = client.get("/api/health", HTTP_HOST="10.0.0.5:10000")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    # Other endpoints keep host validation.
    assert client.get("/api/ready", HTTP_HOST="10.0.0.5:10000").status_code == 400


def test_ready_reports_storage_problems_by_category(settings, monkeypatch):
    from apps.media import storage

    settings.MEDIA_STORAGE = "none"
    assert storage.storage_status() == "not_configured"

    class Denied(Exception):
        response = {"Error": {"Code": "InvalidAccessKeyId"}}

    class Fake(storage.S3Storage):
        def __init__(self):
            self.bucket = "b"
            self.client = type("C", (), {"head_object": lambda *a, **k: (_ for _ in ()).throw(Denied())})()

    settings.MEDIA_STORAGE = "s3"
    monkeypatch.setattr(storage, "get_storage", lambda: Fake())
    storage._check_cache.clear()
    assert storage.storage_status() == "error: access denied [InvalidAccessKeyId] (check the access key, secret and that the token covers this bucket)"
    storage._check_cache.clear()

    class Missing(Exception):
        response = {"Error": {"Code": "404"}}

    Fake.__init__ = lambda self: (setattr(self, "bucket", "b"), setattr(self, "client", type("C", (), {"head_object": lambda *a, **k: (_ for _ in ()).throw(Missing())})()))[0]
    assert storage.storage_status() == "configured"
    storage._check_cache.clear()


@pytest.mark.django_db
def test_verify_restore_checks_a_copy_and_refuses_production(world, settings, capsys):
    import json

    from django.core.management import CommandError, call_command

    from .test_progress import review, task

    review(world, task(world), "accept")  # one submission with feedback
    with pytest.raises(CommandError):     # no Quran text imported in the test database
        call_command("verify_restore")
    out = json.loads(capsys.readouterr().out)
    c = out["checks"]
    assert c["migrations"] == "ok" and c["sign_in_teacher"] == "ok" and c["sign_in_student"] == "ok"
    assert c["parent_sees_linked_child"] == "ok" and c["teacher_sees_assigned_student"] == "ok"
    assert c["student_sees_feedback"] == "ok" and c["submission_media_metadata"] == "ok"
    assert c["quran"].startswith("failed") and out["counts"]["feedback"] == 1
    assert "@" not in json.dumps(out)  # no email addresses in the report
    settings.APP_ENV = "production"
    with pytest.raises(CommandError, match="refuses"):
        call_command("verify_restore")
