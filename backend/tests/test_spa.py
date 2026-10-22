"""The admin portal is served from /admin/ with its own page (and manifest), so it installs as a separate app."""
from django.test import RequestFactory

from apps.core import spa


def test_admin_path_serves_the_admin_page(tmp_path, settings):
    (tmp_path / "admin").mkdir()
    (tmp_path / "index.html").write_text('<link rel="manifest" href="/manifest.webmanifest">')
    (tmp_path / "admin" / "index.html").write_text('<link rel="manifest" href="/admin/manifest.webmanifest">')
    settings.WHITENOISE_ROOT = tmp_path
    rf = RequestFactory()
    body = lambda r: b"".join(r.streaming_content).decode()  # noqa: E731
    assert "/admin/manifest" in body(spa.index(rf.get("/admin/")))
    assert "/admin/manifest" in body(spa.index(rf.get("/admin/students")))
    learner = spa.index(rf.get("/"))
    assert 'href="/manifest.webmanifest"' in body(learner) and learner["Cache-Control"] == "no-cache"
    r = spa.index(rf.get("/admin"))
    assert r.status_code == 301 and r["Location"] == "/admin/"


def test_admin_service_and_redirect_to_it(tmp_path, settings):
    (tmp_path / "admin").mkdir()
    (tmp_path / "index.html").write_text("learner")
    (tmp_path / "admin" / "index.html").write_text("admin")
    settings.WHITENOISE_ROOT = tmp_path
    rf = RequestFactory()
    settings.ADMIN_URL = "https://halqa-admin.example"
    r = spa.index(rf.get("/admin/students"))
    assert r.status_code == 302 and r["Location"] == "https://halqa-admin.example/admin/"
    assert b"".join(spa.index(rf.get("/")).streaming_content) == b"learner"
    settings.PORTAL = "admin"
    assert spa.index(rf.get("/")).status_code == 302 and spa.index(rf.get("/"))["Location"] == "/admin/"
    assert b"".join(spa.index(rf.get("/admin/")).streaming_content) == b"admin"
