"""Trusted devices (owner request 22 October 2026): after a correct code, «تذكّر هذا الجهاز» lets that browser sign in to
the admin portal with the password alone for 30 days. Password still required; revocable; ends on password/MFA change."""
import time
from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts import totp
from apps.accounts.models import TrustedDevice, User
from apps.accounts.trusted import COOKIE
from apps.core.models import AuditEvent

from .conftest import PW, make_user

pytestmark = pytest.mark.django_db
LOGIN = "/api/v1/admin/auth/login"
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1"


@pytest.fixture
def admin():
    u = make_user("boss@x.test", "admin", is_staff=True)
    u.mfa_secret, u.mfa_enabled = totp.new_secret(), True
    u.save()
    return u


def code(u):
    return totp._code(u.mfa_secret, int(time.time() // 30))


def browser():
    return APIClient(HTTP_USER_AGENT=UA)


def login(c, **kw):
    return c.post(LOGIN, {"email": "boss@x.test", "password": PW, **kw}, format="json")


def portal(c):
    return c.get("/api/v1/admin/trusted-devices", HTTP_X_HALQA_PORTAL="admin")


def test_trusted_browser_skips_the_code_but_not_the_password(admin):
    c = browser()
    assert login(c).json()["code"] == "mfa_required"
    r = login(c, otp=code(admin), trust_device=True)
    assert r.status_code == 200 and r.cookies[COOKIE]["httponly"]
    raw = r.cookies[COOKIE].value
    d = TrustedDevice.objects.get(user=admin)
    assert d.token_hash != raw and d.label == "Safari — iPhone" and d.expires_at > timezone.now() + timedelta(days=29)
    c.post("/api/v1/auth/logout", HTTP_X_HALQA_PORTAL="admin")
    assert login(c).status_code == 200  # same browser: password only
    assert login(c, password="wrong-password-1").status_code in (400, 401)
    assert AuditEvent.objects.filter(action="auth.mfa_trusted_device").count() == 1
    other = browser()
    assert login(other).json()["code"] == "mfa_required"  # another browser still needs the code
    other.cookies[COOKIE] = "forged-token"
    assert login(other).json()["code"] == "mfa_required"


def test_without_ticking_nothing_is_remembered(admin):
    c = browser()
    r = login(c, otp=code(admin))
    assert r.status_code == 200 and COOKIE not in r.cookies and not TrustedDevice.objects.exists()
    assert login(c).json()["code"] == "mfa_required"


def test_expiry_password_change_and_mfa_reset_end_the_trust(admin):
    c = browser()
    login(c, otp=code(admin), trust_device=True)
    TrustedDevice.objects.update(expires_at=timezone.now() - timedelta(minutes=1))
    assert login(c).json()["code"] == "mfa_required"
    login(c, otp=code(admin), trust_device=True)
    admin.set_password("a-brand-new-pass-77")
    admin.save()
    r = c.post(LOGIN, {"email": "boss@x.test", "password": "a-brand-new-pass-77"}, format="json")
    assert r.json()["code"] == "mfa_required"
    admin.set_password(PW)
    admin.save()
    login(c, otp=code(admin), trust_device=True)
    User.objects.filter(pk=admin.pk).update(mfa_secret=totp.new_secret())  # authenticator replaced
    assert login(c).json()["code"] == "mfa_required"


def test_list_and_revoke_devices(admin):
    a, b = browser(), browser()
    login(a, otp=code(admin), trust_device=True)
    login(b, otp=code(admin), trust_device=True)
    rows = portal(a).json()["results"]
    assert len(rows) == 2 and sum(r["current"] for r in rows) == 1 and "token" not in str(rows)
    other = next(r for r in rows if not r["current"])
    assert a.post(f"/api/v1/admin/trusted-devices/{other['id']}/revoke", HTTP_X_HALQA_PORTAL="admin").status_code == 200
    b.post("/api/v1/auth/logout", HTTP_X_HALQA_PORTAL="admin")
    assert login(b).json()["code"] == "mfa_required"
    assert a.delete("/api/v1/admin/trusted-devices", HTTP_X_HALQA_PORTAL="admin").json()["removed"] == 1
    a.post("/api/v1/auth/logout", HTTP_X_HALQA_PORTAL="admin")
    assert login(a).json()["code"] == "mfa_required"
    assert AuditEvent.objects.filter(action="auth.devices_untrusted").count() == 2


def test_devices_are_private_to_each_admin(admin, world):
    c = browser()
    login(c, otp=code(admin), trust_device=True)
    d = TrustedDevice.objects.get()
    from .conftest import client_for

    assert client_for(world.admin).post(f"/api/v1/admin/trusted-devices/{d.pk}/revoke").status_code == 404
    assert client_for(world.admin).get("/api/v1/admin/trusted-devices").json()["results"] == []
    assert client_for(world.t1).get("/api/v1/admin/trusted-devices").status_code == 403


def test_trusted_devices_report_is_read_only_and_prints_no_secrets(admin):
    import json
    from io import StringIO

    from django.core.management import call_command

    c = browser()
    login(c)
    raw = login(c, otp=code(admin), trust_device=True).cookies[COOKIE].value
    out = StringIO()
    call_command("trusted_devices_report", stdout=out)
    row = json.loads(out.getvalue().splitlines()[0])
    assert row["admin"] == admin.pk and row["devices_active"] == 1 and row["devices_active_matching"] == 1
    assert row["audit_30d"]["auth.device_trusted"] == 1
    assert raw not in out.getvalue() and "@" not in out.getvalue()
    assert TrustedDevice.objects.count() == 1


def test_login_reports_the_trusted_device_and_the_list_marks_it_current(admin):
    c = browser()
    assert login(c).json()["code"] == "mfa_required"
    r = login(c, otp=code(admin), trust_device=True).json()
    assert r["trusted_device"]["days"] == 30 and "used_trusted_device" not in r
    rows = portal(c).json()["results"]
    assert len(rows) == 1 and rows[0]["current"] is True and rows[0]["label"] == "Safari — iPhone"
    from datetime import datetime

    left = datetime.fromisoformat(rows[0]["expires_at"]) - timezone.now()
    assert timedelta(days=29, hours=23) < left <= timedelta(days=30)
    c.post("/api/v1/auth/logout", HTTP_X_HALQA_PORTAL="admin")
    r = login(c).json()  # password only
    assert r["used_trusted_device"] is True and "trusted_device" not in r


def test_trust_ends_on_expiry_password_change_mfa_reset_and_revocation(admin):
    from django.core.cache import cache

    def trusted_browser():
        cache.clear()  # the auth throttle (10/min) is not what this test is about
        c = browser()
        login(c)
        assert login(c, otp=code(User.objects.get(pk=admin.pk)), trust_device=True).status_code == 200  # current secret
        c.post("/api/v1/auth/logout", HTTP_X_HALQA_PORTAL="admin")
        assert login(c).status_code == 200
        c.post("/api/v1/auth/logout", HTTP_X_HALQA_PORTAL="admin")
        return c

    c = trusted_browser()
    TrustedDevice.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
    assert login(c).json()["code"] == "mfa_required"  # expired
    c = trusted_browser()
    u = User.objects.get(pk=admin.pk)
    u.set_password(PW)  # same text, new hash: the marker no longer matches
    u.save()
    assert login(c).json()["code"] == "mfa_required"
    c = trusted_browser()
    u = User.objects.get(pk=admin.pk)
    u.mfa_secret = totp.new_secret()  # authenticator reset
    u.save()
    assert login(c).json()["code"] == "mfa_required"
    c = trusted_browser()
    d = TrustedDevice.objects.filter(revoked_at__isnull=True).latest("pk")
    login(c, otp=code(User.objects.get(pk=admin.pk)))  # a session to call the API with
    assert c.post(f"/api/v1/admin/trusted-devices/{d.pk}/revoke", HTTP_X_HALQA_PORTAL="admin").status_code == 200
    c.post("/api/v1/auth/logout", HTTP_X_HALQA_PORTAL="admin")
    assert login(c).json()["code"] == "mfa_required"
