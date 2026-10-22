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
