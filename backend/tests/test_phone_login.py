"""Sign in with email OR a verified phone number (owner request, 23 Oct 2026). phones.py, sms.py, views._BaseLogin."""
import json
import time
from datetime import timedelta

import pytest
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts import phones, totp
from apps.accounts.models import AccountStatus, PhoneVerification, Role, User
from apps.core.models import AuditEvent

from .conftest import PW, client_for, make_user

GENERIC = "البريد أو رقم الهاتف أو كلمة المرور غير صحيحة."


@pytest.fixture
def sms(settings, tmp_path):
    settings.SMS_PROVIDER, settings.SMS_FILE_PATH = "file", str(tmp_path / "sms.jsonl")
    cache.clear()
    yield tmp_path / "sms.jsonl"
    cache.clear()


def last_code(path):
    return json.loads(path.read_text(encoding="utf-8").splitlines()[-1])["body"].split(": ")[1][:6]


def verify(user, path, number="01012345678"):
    c = client_for(user)
    r = c.post("/api/v1/me/phone/start", {"phone": number}, format="json")
    assert r.status_code == 200, r.content
    r = c.post("/api/v1/me/phone/confirm", {"code": last_code(path)}, format="json")
    assert r.status_code == 200, r.content
    return r.json()


def login(identifier, password=PW, portal=False, **extra):
    url = "/api/v1/admin/auth/login" if portal else "/api/v1/auth/login"
    return APIClient().post(url, {"identifier": identifier, "password": password, "client": "native", **extra}, format="json")


# 1 ---------------------------------------------------------------------------------------------
def test_normalization_and_masking():
    assert phones.normalize("01012345678") == "+201012345678"
    assert phones.normalize("+20 101 234 5678") == "+201012345678"
    assert phones.normalize("00201012345678") == "+201012345678"
    assert phones.normalize("٠١٠١٢٣٤٥٦٧٨") == "+201012345678"
    assert phones.normalize("+966501234567") == "+966501234567"
    for bad in ("", "123", "0101234", "a@b.co", "not a phone"):
        assert phones.normalize(bad) == ""
    assert phones.mask("+201012345678") == "+20•••••••678"


# 2 ---------------------------------------------------------------------------------------------
@pytest.mark.django_db
def test_without_sms_provider_phone_verification_is_unavailable_and_email_login_works(settings):
    settings.SMS_PROVIDER = ""
    u = make_user("nosms@x.test")
    r = client_for(u).post("/api/v1/me/phone/start", {"phone": "01012345678"}, format="json")
    assert r.status_code == 503 and r.json()["code"] == "sms_unavailable"
    assert login("nosms@x.test").status_code == 200
    from apps.accounts import sms as sms_mod

    assert sms_mod.status() == "not_configured" and not phones.available()


# 3–4 -------------------------------------------------------------------------------------------
@pytest.mark.django_db
def test_code_is_hashed_one_time_and_login_with_local_number(sms):
    u = make_user("ph1@x.test")
    out = client_for(u).post("/api/v1/me/phone/start", {"phone": "010 1234 5678"}, format="json").json()
    assert out["phone"] == "+20•••••••678" and out["expires_in"] == 300
    code = last_code(sms)
    v = PhoneVerification.objects.get(user=u)
    assert code not in v.code_hash and len(v.code_hash) == 64
    c = client_for(u)
    me = c.post("/api/v1/me/phone/confirm", {"code": code}, format="json").json()
    assert me["phone_verified"] is True and me["phone"] == "+201012345678"
    assert c.post("/api/v1/me/phone/confirm", {"code": code}, format="json").status_code == 400  # one-time
    for ident in ("01012345678", "+201012345678", "ph1@x.test"):
        assert login(ident).status_code == 200, ident
    acts = list(AuditEvent.objects.filter(action__startswith="phone.").values_list("data", flat=True))
    assert code not in str(acts) and "+201012345678" not in str(acts)


# 5–6 -------------------------------------------------------------------------------------------
@pytest.mark.django_db
def test_wrong_attempts_expiry_and_limits(sms, settings):
    u = make_user("ph2@x.test")
    c = client_for(u)
    c.post("/api/v1/me/phone/start", {"phone": "01011111111"}, format="json")
    code = last_code(sms)
    for _ in range(settings.PHONE_CODE_ATTEMPTS):
        assert c.post("/api/v1/me/phone/confirm", {"code": "000000" if code != "000000" else "111111"}, format="json").status_code == 400
    assert c.post("/api/v1/me/phone/confirm", {"code": code}, format="json").status_code == 400  # burned after 5 tries
    # Resend cooldown, then the hourly cap.
    r = c.post("/api/v1/me/phone/start", {"phone": "01011111111"}, format="json")
    assert r.status_code == 429 and r.json()["code"] == "resend_wait"
    PhoneVerification.objects.update(created_at=timezone.now() - timedelta(minutes=2))
    assert c.post("/api/v1/me/phone/start", {"phone": "01011111111"}, format="json").status_code == 200
    PhoneVerification.objects.filter(pk=PhoneVerification.objects.latest("pk").pk).update(expires_at=timezone.now() - timedelta(seconds=1))
    assert c.post("/api/v1/me/phone/confirm", {"code": last_code(sms)}, format="json").status_code == 400  # expired
    for _ in range(settings.PHONE_SENDS_PER_HOUR):
        PhoneVerification.objects.update(created_at=timezone.now() - timedelta(minutes=2))
        r = c.post("/api/v1/me/phone/start", {"phone": "01011111111"}, format="json")
    assert r.status_code == 429 and r.json()["code"] == "too_many_codes"
    assert User.objects.get(pk=u.pk).phone_verified_at is None


# 7 ---------------------------------------------------------------------------------------------
@pytest.mark.django_db
def test_a_verified_number_belongs_to_one_account(sms):
    a, b = make_user("pa@x.test"), make_user("pb@x.test")
    verify(a, sms, "01022222222")
    r = client_for(b).post("/api/v1/me/phone/start", {"phone": "+201022222222"}, format="json")
    assert r.status_code == 409 and r.json()["code"] == "phone_unavailable"
    # Race: b received a code before a confirmed; the database constraint still keeps one owner.
    c, d = make_user("pc@x.test"), make_user("pd@x.test")
    client_for(c).post("/api/v1/me/phone/start", {"phone": "01033333333"}, format="json")
    code_c = last_code(sms)
    client_for(d).post("/api/v1/me/phone/start", {"phone": "01033333333"}, format="json")
    code_d = last_code(sms)
    assert client_for(c).post("/api/v1/me/phone/confirm", {"code": code_c}, format="json").status_code == 200
    assert client_for(d).post("/api/v1/me/phone/confirm", {"code": code_d}, format="json").status_code == 409
    assert User.objects.filter(phone_e164="+201033333333", phone_verified_at__isnull=False).count() == 1


# 8–9 -------------------------------------------------------------------------------------------
@pytest.mark.django_db
def test_unverified_phone_and_wrong_password_get_the_same_generic_error(sms):
    u = make_user("ph3@x.test")
    User.objects.filter(pk=u.pk).update(phone="+201044444444", phone_e164="+201044444444")  # not verified
    for ident, pw in (("01044444444", PW), ("ph3@x.test", "wrong-Password-1"), ("nobody@x.test", PW), ("01099999999", PW), ("12", PW)):
        r = login(ident, pw)
        assert r.status_code == 400 and r.json()["message"] == GENERIC, ident


# 10 --------------------------------------------------------------------------------------------
@pytest.mark.django_db
def test_lockout_is_per_account_whatever_the_identifier(sms, settings):
    settings.LOGIN_LOCKOUT_FAILURES = 4
    u = make_user("ph4@x.test")
    verify(u, sms, "01055555555")
    for ident in ("ph4@x.test", "01055555555", "+201055555555", "PH4@x.test"):
        assert login(ident, "wrong-Password-1").status_code == 400
    for ident in ("ph4@x.test", "01055555555"):
        r = login(ident)  # right password, but the account is locked
        assert r.status_code == 429 and r.json()["code"] == "account_locked", ident


# 11 --------------------------------------------------------------------------------------------
@pytest.mark.django_db
def test_suspended_and_archived_accounts_are_refused_by_phone_too(sms):
    u = make_user("ph5@x.test")
    verify(u, sms, "01066666666")
    for st in (AccountStatus.SUSPENDED, AccountStatus.ARCHIVED):
        User.objects.filter(pk=u.pk).update(status=st)
        assert login("01066666666").json()["code"] == "account_suspended"


# 12 --------------------------------------------------------------------------------------------
@pytest.mark.django_db
def test_admin_phone_login_still_needs_two_step_verification(sms):
    a = make_user("adm-ph@x.test", Role.ADMIN, is_staff=True)
    verify(a, sms, "01077777777")
    a.refresh_from_db()
    a.mfa_secret, a.mfa_enabled = totp.new_secret(), True
    a.save()
    assert login("01077777777", portal=True).json()["code"] == "mfa_required"
    assert login("01077777777", portal=True, otp="000000").json()["code"] == "mfa_invalid"
    ok = login("01077777777", portal=True, otp=totp._code(a.mfa_secret, int(time.time() // 30)))
    assert ok.status_code == 200 and ok.json()["user"]["role"] == "admin"
    assert login("01077777777").json()["code"] == "admin_portal_only"  # learners' app still refuses admins


# 13 --------------------------------------------------------------------------------------------
@pytest.mark.django_db
def test_password_reset_stays_email_only(sms, settings):
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    from django.core import mail

    u = make_user("ph6@x.test")
    verify(u, sms, "01088888888")
    lines = len(sms.read_text(encoding="utf-8").splitlines())
    r = APIClient().post("/api/v1/auth/password/forgot", {"email": "01088888888"}, format="json")
    assert r.status_code in (200, 202) and not mail.outbox
    assert len(sms.read_text(encoding="utf-8").splitlines()) == lines  # nothing sent by SMS either


# 14 --------------------------------------------------------------------------------------------
@pytest.mark.django_db
def test_changing_the_number_verifies_the_new_one_before_replacing(sms):
    u = make_user("ph7@x.test")
    verify(u, sms, "01012121212")
    c = client_for(u)
    assert c.patch("/api/v1/me", {"phone": "01099990000"}, format="json").status_code == 400  # not through the profile
    PhoneVerification.objects.update(created_at=timezone.now() - timedelta(minutes=2))  # past the resend wait
    assert c.post("/api/v1/me/phone/start", {"phone": "01034343434"}, format="json").status_code == 200
    assert login("01012121212").status_code == 200  # the old number still works meanwhile
    assert login("01034343434").status_code == 400
    assert c.post("/api/v1/me/phone/confirm", {"code": last_code(sms)}, format="json").status_code == 200
    assert login("01034343434").status_code == 200 and login("01012121212").status_code == 400
    assert AuditEvent.objects.filter(action="phone.verified", data__replaced="+20•••••••212").exists()


# 15 --------------------------------------------------------------------------------------------
@pytest.mark.django_db
def test_admin_views_mask_phones_without_contact_permission(sms, world):
    from apps.accounts.models import AdminProfile

    verify(world.s1, sms, "01056565656")
    viewer = make_user("ro@x.test", Role.ADMIN, owner=False)
    AdminProfile.objects.create(user=viewer, access_level="admin", preset="read_only", permissions=["users.view"])
    masked = client_for(viewer).get(f"/api/v1/admin/users/{world.s1.pk}").json()
    assert masked["phone"] == "+20•••••••656" and masked["phone_verified"] is True
    full = client_for(world.admin).get(f"/api/v1/admin/users/{world.s1.pk}").json()
    assert full["phone"] == "+201056565656"
    # A verified number is changed by its owner only (after verifying the new one).
    r = client_for(world.admin).patch(f"/api/v1/admin/users/{world.s1.pk}", {"phone": "01000000001"}, format="json")
    assert r.status_code == 409 and r.json()["code"] == "phone_verified"


# 16 --------------------------------------------------------------------------------------------
@pytest.mark.django_db
def test_older_apps_sending_email_still_sign_in(sms):
    make_user("legacy@x.test")
    r = APIClient().post("/api/v1/auth/login", {"email": "legacy@x.test", "password": PW, "client": "native"}, format="json")
    assert r.status_code == 200
    r = APIClient().post("/api/v1/auth/login", {"password": PW}, format="json")
    assert r.status_code == 400
