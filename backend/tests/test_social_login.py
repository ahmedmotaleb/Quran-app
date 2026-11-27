"""Social sign-in and «طرق تسجيل الدخول» (owner request 27 Nov 2026): apps/accounts/oidc.py and social.py.

The flow tests use the development stand-in provider («fake»), which signs real RS256 ID tokens, so state, browser
binding, code exchange, signature, issuer, audience, expiry and nonce checks all run as in production. The provider
specific rules (Google, Microsoft, Apple) are tested on the same verification code with locally signed tokens.
"""
import json
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts import oidc
from apps.accounts.models import AuthIdentity, LoginSession, Role, TeacherProfile, User
from apps.core.audit import AuditEvent
from apps.notifications.models import PushSubscription

from .conftest import PW, client_for, make_user

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def fake_idp(settings):
    settings.AUTH_OAUTH_FAKE = True


def frag(location: str) -> dict:
    assert "#/oauth?" in location, location
    return {k: v[0] for k, v in parse_qs(location.split("#/oauth?", 1)[1]).items()}


def provider_round(c: APIClient, *, sub="g-1", email="new@x.test", verified=True, name="عمر خالد", intent="login") -> dict:
    """Start → the provider's consent → our callback. Returns the app fragment the callback redirects to."""
    r = c.post("/api/v1/auth/oauth/fake/start", {"intent": intent}, format="json")
    assert r.status_code == 200, r.json()
    q = parse_qs(urlparse(r.json()["auth_url"]).query)
    assert q["code_challenge_method"] == ["S256"] and q["code_challenge"][0] and q["nonce"][0] and q["state"][0]
    consent = c.get("/api/v1/auth/oauth/fake/authorize", {"state": q["state"][0], "nonce": q["nonce"][0], "sub": sub, "email": email,
                                                          "email_verified": "true" if verified else "false", "name": name})
    assert consent.status_code == 302
    back = urlparse(consent["Location"])
    cb = c.get(back.path, {k: v[0] for k, v in parse_qs(back.query).items()})
    assert cb.status_code == 302
    return frag(cb["Location"])


def signup(c, ticket, role="student", **kw):
    return c.post("/api/v1/auth/oauth/signup", {"ticket": ticket, "role": role, "full_name": kw.get("name", "عمر خالد"),
                                                "gender": kw.get("gender", "male"), "timezone": "Africa/Cairo"}, format="json")


# ---- new accounts ---------------------------------------------------------------------------------------------------
def test_new_student_registers_with_a_provider_and_chooses_the_role():
    c = APIClient()
    f = provider_round(c)
    assert f["signup"] and f["name"] == "عمر خالد" and f["email"].startswith("ne") and "@x.test" in f["email"]
    r = signup(c, f["signup"])
    assert r.status_code == 201, r.json()
    u = User.objects.get(email="new@x.test")
    assert u.role == Role.STUDENT and not u.has_usable_password() and hasattr(u, "student_profile")
    assert AuthIdentity.objects.get(user=u).subject == "g-1"
    assert c.get("/api/v1/me").json()["email"] == "new@x.test"                  # signed in (web session)
    assert LoginSession.objects.get(user=u).method == "fake"
    assert signup(c, f["signup"]).status_code == 400                           # the ticket is single-use


def test_teacher_signup_waits_for_approval_and_admin_is_never_created(world):
    c = APIClient()
    f = provider_round(c, sub="t-9", email="teach@x.test")
    assert signup(c, f["signup"], role="admin").status_code == 400            # never from the role picker
    assert signup(c, f["signup"], role="teacher").status_code == 201          # the ticket was not spent by the refusal
    u = User.objects.get(email="teach@x.test")
    assert u.role == Role.TEACHER and TeacherProfile.objects.get(user=u).approved_at is None    # the existing approval decides
    assert c.get("/api/v1/teachers").json()["results"] == [] or all(t["id"] != u.pk for t in c.get("/api/v1/teachers").json()["results"])


def test_parent_signup_sees_no_children_until_an_admin_links_them():
    c = APIClient()
    f = provider_round(c, sub="p-1", email="par@x.test")
    assert signup(c, f["signup"], role="parent").status_code == 201
    assert c.get("/api/v1/parent/children").json()["results"] == []


def test_signing_in_again_opens_the_same_account_never_a_duplicate():
    c = APIClient()
    signup(c, provider_round(c)["signup"])
    c2 = APIClient()
    f = provider_round(c2)
    assert "ticket" in f
    r = c2.post("/api/v1/auth/oauth/finish", {"ticket": f["ticket"]}, format="json")
    assert r.status_code == 200 and r.json()["user"]["email"] == "new@x.test"
    assert User.objects.filter(email="new@x.test").count() == 1 and AuthIdentity.objects.count() == 1
    assert AuthIdentity.objects.get().last_login_at is not None
    assert c2.post("/api/v1/auth/oauth/finish", {"ticket": f["ticket"]}, format="json").status_code == 400   # single use


def test_native_app_gets_a_token():
    c = APIClient()
    signup(c, provider_round(c)["signup"])
    c2 = APIClient()
    r = c2.post("/api/v1/auth/oauth/finish", {"ticket": provider_round(c2)["ticket"], "client": "native", "device": "Pixel"}, format="json")
    tok = r.json()["token"]
    me = APIClient()
    me.credentials(HTTP_AUTHORIZATION=f"Bearer {tok}")
    assert me.get("/api/v1/me").json()["email"] == "new@x.test"


def test_unverified_email_never_creates_or_opens_an_account(world):
    c = APIClient()
    assert provider_round(c, email="other@x.test", verified=False)["result"] == "email_unverified"
    assert provider_round(APIClient(), sub="z", email=world.s1.email, verified=False)["result"] == "link_required"
    assert not User.objects.filter(email="other@x.test").exists() and not AuthIdentity.objects.exists()


def test_signup_closed_is_respected():
    from apps.core.models import AppSettings

    s = AppSettings.load()
    s.open_signup = False
    s.save()
    assert provider_round(APIClient())["result"] == "signup_closed"


# ---- existing accounts: no automatic merge ----------------------------------------------------------------------------
def test_existing_email_is_not_merged_without_the_mailbox_confirmation(world, settings, tmp_path):
    settings.EMAIL_BACKEND = "django.core.mail.backends.filebased.EmailBackend"
    settings.EMAIL_FILE_PATH = str(tmp_path)
    c = APIClient()
    f = provider_round(c, sub="g-s1", email=world.s1.email)
    assert f["result"] == "link_email_sent" and "@" in f["email"]
    assert not AuthIdentity.objects.exists() and c.get("/api/v1/me").status_code in (401, 403)     # nothing linked, not signed in
    mail = "".join(p.read_text() for p in Path(tmp_path).iterdir())
    token = mail.split("confirm=")[1].split()[0].split('"')[0]
    r = APIClient().post("/api/v1/auth/oauth/confirm", {"token": token}, format="json")
    assert r.status_code == 200 and r.json()["user"]["email"] == world.s1.email
    assert AuthIdentity.objects.get().user == world.s1 and User.objects.filter(email=world.s1.email).count() == 1
    assert APIClient().post("/api/v1/auth/oauth/confirm", {"token": token}, format="json").status_code == 400   # once


def test_connect_from_settings_and_refuse_someone_elses_provider_account(world):
    c = client_for(world.s1)
    r = c.post("/api/v1/auth/oauth/fake/start", {"intent": "link"}, format="json")
    q = parse_qs(urlparse(r.json()["auth_url"]).query)
    back = urlparse(c.get("/api/v1/auth/oauth/fake/authorize", {"state": q["state"][0], "nonce": q["nonce"][0], "sub": "g-x",
                                                                  "email": "whatever@x.test", "email_verified": "true"})["Location"])
    assert frag(c.get(back.path, {k: v[0] for k, v in parse_qs(back.query).items()})["Location"])["result"] == "linked"
    m = c.get("/api/v1/me/auth-methods").json()
    assert m["has_password"] is True and next(p for p in m["providers"] if p["id"] == "fake")["connected"] is True
    c2 = client_for(world.s2)                                          # the same provider account for another person: refused
    r = c2.post("/api/v1/auth/oauth/fake/start", {"intent": "link"}, format="json")
    q = parse_qs(urlparse(r.json()["auth_url"]).query)
    back = urlparse(c2.get("/api/v1/auth/oauth/fake/authorize", {"state": q["state"][0], "nonce": q["nonce"][0], "sub": "g-x", "email": "w@x.test",
                                                                   "email_verified": "true"})["Location"])
    assert frag(c2.get(back.path, {k: v[0] for k, v in parse_qs(back.query).items()})["Location"])["result"] == "identity_in_use"
    assert AuthIdentity.objects.get(subject="g-x").user == world.s1
    assert APIClient().post("/api/v1/auth/oauth/fake/start", {"intent": "link"}, format="json").status_code == 401


def test_data_is_preserved_when_a_provider_is_connected(world):
    from apps.accounts.models import GuardianLink, TeacherAssignment

    world.s1.notify_prefs = {"sessions": False}
    world.s1.save()
    c = client_for(world.s1)
    r = c.post("/api/v1/auth/oauth/fake/start", {"intent": "link"}, format="json")
    q = parse_qs(urlparse(r.json()["auth_url"]).query)
    back = urlparse(c.get("/api/v1/auth/oauth/fake/authorize", {"state": q["state"][0], "nonce": q["nonce"][0], "sub": "keep-1", "email": "k@x.test",
                                                                  "email_verified": "true"})["Location"])
    c.get(back.path, {k: v[0] for k, v in parse_qs(back.query).items()})
    c2 = APIClient()
    t = provider_round(c2, sub="keep-1", email="k@x.test")["ticket"]
    me = c2.post("/api/v1/auth/oauth/finish", {"ticket": t}, format="json").json()["user"]
    assert me["id"] == world.s1.pk
    u = User.objects.get(pk=world.s1.pk)
    assert u.notify_prefs == {"sessions": False} and u.check_password(PW)
    assert TeacherAssignment.objects.filter(student=u, active=True).exists() and GuardianLink.objects.filter(student=u).exists()


# ---- refusals ---------------------------------------------------------------------------------------------------------
def test_admin_and_suspended_accounts_cannot_sign_in_with_a_provider(world):
    AuthIdentity.objects.create(user=world.admin, provider="fake", subject="adm", email=world.admin.email, email_verified=True)
    c = APIClient()
    r = c.post("/api/v1/auth/oauth/finish", {"ticket": provider_round(c, sub="adm", email=world.admin.email)["ticket"]}, format="json")
    assert r.status_code == 403 and r.json()["code"] == "admin_portal_only"
    AuthIdentity.objects.create(user=world.s2, provider="fake", subject="sus", email="s@x.test", email_verified=True)
    world.s2.status = "suspended"
    world.s2.save()
    c = APIClient()
    assert c.post("/api/v1/auth/oauth/finish", {"ticket": provider_round(c, sub="sus")["ticket"]}, format="json").json()["code"] == "account_suspended"


def test_state_is_single_use_and_bound_to_the_browser():
    c = APIClient()
    r = c.post("/api/v1/auth/oauth/fake/start", {"intent": "login"}, format="json")
    q = parse_qs(urlparse(r.json()["auth_url"]).query)
    back = urlparse(c.get("/api/v1/auth/oauth/fake/authorize", {"state": q["state"][0], "nonce": q["nonce"][0], "sub": "s",
                                                                  "email": "s@x.test", "email_verified": "true"})["Location"])
    params = {k: v[0] for k, v in parse_qs(back.query).items()}
    other = APIClient()                                                       # another browser cannot use this callback
    assert frag(other.get(back.path, params)["Location"]) == {"result": "failed", "reason": "state_invalid"}
    assert "signup" in frag(c.get(back.path, params)["Location"])                          # the right browser still finishes
    assert frag(c.get(back.path, params)["Location"])["reason"] == "state_expired"          # then the state is used up
    assert AuditEvent.objects.filter(action="auth.oauth_failed").count() == 2


def test_provider_cancel_returns_quietly():
    c = APIClient()
    assert frag(c.get("/api/v1/auth/oauth/fake/callback", {"error": "access_denied"})["Location"]) == {"result": "cancelled"}


def test_unconfigured_providers_are_not_offered(settings):
    settings.AUTH_GOOGLE_CLIENT_ID = settings.AUTH_GOOGLE_CLIENT_SECRET = ""
    settings.AUTH_MICROSOFT_CLIENT_ID = settings.AUTH_APPLE_CLIENT_ID = ""
    assert [p["id"] for p in APIClient().get("/api/v1/auth/oauth/providers").json()["providers"]] == ["fake"]
    assert APIClient().post("/api/v1/auth/oauth/google/start", {}, format="json").status_code == 404
    settings.AUTH_OAUTH_FAKE = False
    assert APIClient().get("/api/v1/auth/oauth/fake/authorize").status_code == 404


# ---- «طرق تسجيل الدخول» ------------------------------------------------------------------------------------------------
def test_last_way_in_cannot_be_removed_and_a_password_can_be_set_after_a_fresh_sign_in():
    c = APIClient()
    signup(c, provider_round(c)["signup"])
    r = c.delete("/api/v1/me/auth-methods/fake")
    assert r.status_code == 409 and r.json()["code"] == "last_method"
    LoginSession.objects.update(created_at=timezone.now() - timezone.timedelta(minutes=30))
    assert c.post("/api/v1/auth/password/set", {"password": "Nour-Quran-2026"}, format="json").json()["code"] == "reauth_required"
    LoginSession.objects.update(created_at=timezone.now())
    r = c.post("/api/v1/auth/password/set", {"password": "Nour-Quran-2026"}, format="json")
    assert r.status_code == 200 and r.json()["has_password"] is True
    assert c.get("/api/v1/me").status_code == 200                              # this browser stays signed in
    assert c.delete("/api/v1/me/auth-methods/fake").status_code == 200         # now the password remains
    r = APIClient().post("/api/v1/auth/login", {"identifier": "new@x.test", "password": "Nour-Quran-2026"}, format="json")
    assert r.status_code == 200


def test_sessions_list_end_one_and_end_others_including_their_push(world, settings):
    a, b = APIClient(), APIClient()
    for c in (a, b):
        assert c.post("/api/v1/auth/login", {"identifier": world.s1.email, "password": PW}, format="json", HTTP_USER_AGENT="Mozilla/5.0 (Linux; Android 14) Chrome/130").status_code == 200
    rows = a.get("/api/v1/me/sessions").json()["results"]
    assert len(rows) == 2 and sum(r["current"] for r in rows) == 1 and rows[0]["device"] == "Chrome · Android"
    other = next(r for r in rows if not r["current"])
    settings.VAPID_PUBLIC_KEY, settings.VAPID_PRIVATE_KEY = "x", "y"
    from apps.notifications import push

    if push.configured():
        b.post("/api/v1/push/subscriptions", {"endpoint": "https://push.example.test/b", "keys": {"p256dh": "k", "auth": "a"}}, format="json")
    else:
        PushSubscription.objects.create(user=world.s1, endpoint="https://push.example.test/b", p256dh="k", auth="a",
                                        login_session=LoginSession.objects.get(pk=other["id"]))
    assert a.delete(f"/api/v1/me/sessions/{next(r for r in rows if r['current'])['id']}").json()["code"] == "current_session"
    assert a.delete(f"/api/v1/me/sessions/{other['id']}").status_code == 200
    assert b.get("/api/v1/me").status_code in (401, 403)                       # that device is signed out
    assert not PushSubscription.objects.filter(endpoint="https://push.example.test/b").exists()   # and gets no more notices
    c = APIClient()
    c.post("/api/v1/auth/login", {"identifier": world.s1.email, "password": PW}, format="json")
    tok = client_for(world.s1)                                                  # an app token
    r = a.post("/api/v1/me/sessions/end-others")
    assert r.status_code == 200 and r.json()["ended"] >= 1
    assert c.get("/api/v1/me").status_code in (401, 403) and tok.get("/api/v1/me").status_code in (401, 403)
    assert a.get("/api/v1/me").status_code == 200


def test_logout_ends_the_session_row(world):
    c = APIClient()
    c.post("/api/v1/auth/login", {"identifier": world.s1.email, "password": PW}, format="json")
    assert c.post("/api/v1/auth/logout").status_code == 204
    assert LoginSession.objects.get(user=world.s1).ended_at is not None


# ---- ID token verification per provider ---------------------------------------------------------------------------------
def _sign(claims, monkeypatch, p):
    monkeypatch.setattr(oidc, "_signing_key", lambda prov, tok: oidc._fake_public_key())
    return oidc.fake_sign(claims)


def base(aud, iss, **kw):
    now = int(time.time())
    return {"iss": iss, "aud": aud, "iat": now, "exp": now + 300, "sub": "abc", "nonce": "n-1", **kw}


def test_google_token_rules(settings, monkeypatch):
    settings.AUTH_GOOGLE_CLIENT_ID = "gid"
    ok = _sign(base("gid", "https://accounts.google.com", email="a@x.test", email_verified=True), monkeypatch, "google")
    c = oidc.verify_id_token("google", ok, "n-1")
    assert oidc._identity("google", c, "").email_verified is True
    for bad, code in [(base("other", "https://accounts.google.com"), "token_invalid"),           # audience
                      (base("gid", "https://evil.example"), "token_issuer"),
                      (base("gid", "https://accounts.google.com", nonce="x"), "token_nonce"),
                      ({**base("gid", "https://accounts.google.com"), "exp": int(time.time()) - 3600}, "token_expired")]:
        with pytest.raises(oidc.OidcError) as e:
            oidc.verify_id_token("google", _sign(bad, monkeypatch, "google"), "n-1")
        assert e.value.code == code
    unverified = oidc.verify_id_token("google", _sign(base("gid", "https://accounts.google.com", email="a@x.test", email_verified=False), monkeypatch, "google"), "n-1")
    assert oidc._identity("google", unverified, "").email_verified is False
    with pytest.raises(oidc.OidcError):                                                        # a token not signed by the provider
        oidc.verify_id_token("google", jwt.encode(base("gid", "https://accounts.google.com"), "secret", algorithm="HS256"), "n-1")


def test_microsoft_issuer_per_tenant_and_email_trust(settings, monkeypatch):
    settings.AUTH_MICROSOFT_CLIENT_ID, settings.AUTH_MICROSOFT_TENANT = "mid", "common"
    tid = oidc.MS_CONSUMER_TENANT
    c = oidc.verify_id_token("microsoft", _sign(base("mid", f"https://login.microsoftonline.com/{tid}/v2.0", tid=tid, email="m@outlook.test"), monkeypatch, "m"), "n-1")
    assert oidc._identity("microsoft", c, "").email_verified is True                         # personal account
    work = oidc.verify_id_token("microsoft", _sign(base("mid", "https://login.microsoftonline.com/t-1/v2.0", tid="t-1", email="w@corp.test"), monkeypatch, "m"), "n-1")
    assert oidc._identity("microsoft", work, "").email_verified is False                     # work account without xms_edov
    with pytest.raises(oidc.OidcError) as e:
        oidc.verify_id_token("microsoft", _sign(base("mid", "https://login.microsoftonline.com/t-2/v2.0", tid="t-1"), monkeypatch, "m"), "n-1")
    assert e.value.code == "token_issuer"
    settings.AUTH_MICROSOFT_TENANT = "t-9"                                                      # a single-tenant app
    with pytest.raises(oidc.OidcError):
        oidc.verify_id_token("microsoft", _sign(base("mid", "https://login.microsoftonline.com/t-1/v2.0", tid="t-1"), monkeypatch, "m"), "n-1")


def test_apple_token_name_and_client_secret(settings, monkeypatch):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    key = ec.generate_private_key(ec.SECP256R1())
    settings.AUTH_APPLE_CLIENT_ID, settings.AUTH_APPLE_TEAM_ID, settings.AUTH_APPLE_KEY_ID = "app.halqa.web", "TEAM1", "KEY1"
    settings.AUTH_APPLE_PRIVATE_KEY = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    secret = oidc._client_secret("apple")
    h = jwt.get_unverified_header(secret)
    body = jwt.decode(secret, key.public_key(), algorithms=["ES256"], audience="https://appleid.apple.com")
    assert h["kid"] == "KEY1" and body["iss"] == "TEAM1" and body["sub"] == "app.halqa.web" and body["exp"] - body["iat"] <= 600
    c = oidc.verify_id_token("apple", _sign(base("app.halqa.web", "https://appleid.apple.com", email="r@privaterelay.appleid.com", email_verified="true"), monkeypatch, "a"), "n-1")
    i = oidc._identity("apple", c, json.dumps({"name": {"firstName": "Yusuf", "lastName": "Ali"}}))
    assert i.email_verified is True and i.name == "Yusuf Ali"
    assert oidc.configured("apple") and "response_mode=form_post" in oidc.begin("apple", intent="login")[0]
