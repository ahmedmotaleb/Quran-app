"""Admin settings persist server-side, are audited, need re-authentication when sensitive, and drive behaviour."""
import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from apps.core.models import AppSettings, AuditEvent

from .conftest import PW, client_for

pytestmark = pytest.mark.django_db
A = "/api/v1/admin"


def test_settings_admin_only(world):
    for who in (world.s1, world.t1, world.p1):
        assert client_for(who).get(f"{A}/settings").status_code == 403
        assert client_for(who).patch(f"{A}/settings", {"cancel_hours": 1}, format="json").status_code == 403
        assert client_for(who).get(f"{A}/audit").status_code == 403
    assert APIClient().patch(f"{A}/settings", {"cancel_hours": 1}, format="json").status_code in (401, 403)


def test_safe_setting_persists_audited_and_changes_behaviour(world):
    c = client_for(world.admin)
    r = c.patch(f"{A}/settings", {"cancel_hours": 24, "org_name": "حلقة النور"}, format="json")
    assert r.status_code == 200 and r.json()["cancel_hours"] == 24
    assert AppSettings.load().cancel_hours == 24
    pub = APIClient().get("/api/v1/settings/public").json()
    assert pub["cancel_hours"] == 24 and pub["org_name"] == "حلقة النور" and "support_whatsapp" in pub
    ev = AuditEvent.objects.get(action="admin.settings_changed")
    assert ev.data["changed"]["cancel_hours"] == ["12", "24"] and ev.actor == world.admin
    assert c.get(f"{A}/audit", {"action": "admin.settings"}).json()["results"][0]["action"] == "admin.settings_changed"
    # Unchanged values are not audited again.
    c.patch(f"{A}/settings", {"cancel_hours": 24}, format="json")
    assert AuditEvent.objects.filter(action="admin.settings_changed").count() == 1


def test_validation_ranges_and_timezone(world):
    c = client_for(world.admin)
    assert c.patch(f"{A}/settings", {"cancel_hours": 500}, format="json").status_code == 400
    assert c.patch(f"{A}/settings", {"booking_horizon_days": 0}, format="json").status_code == 400
    r = c.patch(f"{A}/settings", {"default_timezone": "Mars/Base", "current_password": PW}, format="json")
    assert r.status_code == 400 and "default_timezone" in r.json()["fields"]
    assert c.patch(f"{A}/settings", {"support_email": "not-an-email"}, format="json").status_code == 400


def test_sensitive_settings_need_password(world):
    c = client_for(world.admin)
    r = c.patch(f"{A}/settings", {"open_signup": False}, format="json")
    assert r.status_code == 403 and r.json()["code"] == "reauth_required"
    assert c.patch(f"{A}/settings", {"open_signup": False, "current_password": "wrong"}, format="json").status_code == 403
    assert AppSettings.load().open_signup is True
    assert AuditEvent.objects.filter(action="admin.settings_reauth_failed").count() == 2
    assert c.patch(f"{A}/settings", {"open_signup": False, "current_password": PW}, format="json").status_code == 200
    # Behaviour: sign-up is now closed for the public.
    r = APIClient().post("/api/v1/auth/register", {"gender": "male", "full_name": "طالب", "email": "n@x.test", "password": PW, "client": "web"}, format="json")
    assert r.status_code == 403
    assert APIClient().get("/api/v1/settings/public").json()["open_signup"] is False


def test_recording_limit_setting_is_enforced_and_capped(world, settings):
    settings.MEDIA_STORAGE = "local"
    c = client_for(world.admin)
    assert c.patch(f"{A}/settings", {"max_recording_seconds": 60, "current_password": PW}, format="json").status_code == 200
    assert APIClient().get("/api/v1/settings/public").json()["max_recording_seconds"] == 60
    up = lambda dur: client_for(world.s1).post("/api/v1/media/recitations", {  # noqa: E731
        "file": SimpleUploadedFile("r.ogg", b"OggS" + b"\0" * 200, content_type="audio/ogg"), "duration_seconds": dur}, format="multipart")
    assert up(90).status_code == 400
    assert up(30).status_code == 201
    # The admin setting can never exceed the server's hard cap (20 minutes).
    c.patch(f"{A}/settings", {"max_recording_seconds": 3600, "current_password": PW}, format="json")
    assert APIClient().get("/api/v1/settings/public").json()["max_recording_seconds"] == 1200
