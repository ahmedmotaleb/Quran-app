import pytest
from django.core import mail
from rest_framework.test import APIClient

from apps.accounts import totp
from apps.accounts.models import AuthToken, Invitation, Role, User
from apps.core.models import AuditEvent

from .conftest import PW, client_for, make_user


@pytest.mark.django_db
class TestRegistration:
    def test_role_in_body_is_ignored(self):
        r = APIClient().post("/api/v1/auth/register", {"full_name": "مهاجم", "email": "x@x.test", "password": PW, "role": "admin"})
        assert r.status_code == 201
        u = User.objects.get(email="x@x.test")
        assert u.role == Role.STUDENT and not u.is_staff and not u.is_superuser

    def test_weak_password_has_arabic_field_error(self):
        r = APIClient().post("/api/v1/auth/register", {"full_name": "طالب", "email": "y@x.test", "password": "12345678"})
        assert r.status_code == 400
        assert r.json()["fields"]["password"][0] in {"استخدم 10 أحرف على الأقل.", "كلمة المرور شائعة جدًا. اختر كلمة أقوى."}

    def test_duplicate_email_case_insensitive(self):
        make_user("dup@x.test")
        r = APIClient().post("/api/v1/auth/register", {"full_name": "طالب", "email": "DUP@x.test", "password": PW})
        assert r.status_code == 400 and "email" in r.json()["fields"]


@pytest.mark.django_db
class TestLogin:
    def test_web_login_sets_session_and_me_works(self, world):
        c = APIClient(enforce_csrf_checks=True)
        r = c.post("/api/v1/auth/login", {"email": "s1@x.test", "password": PW})
        assert r.status_code == 200 and "token" not in r.json()
        assert c.get("/api/v1/me").json()["email"] == "s1@x.test"

    def test_session_writes_require_csrf(self, world):
        c = APIClient(enforce_csrf_checks=True)
        c.post("/api/v1/auth/login", {"email": "s1@x.test", "password": PW})
        r = c.patch("/api/v1/me", {"full_name": "اسم جديد"}, format="json")
        assert r.status_code == 403  # no CSRF token
        c.get("/api/v1/auth/csrf")
        r = c.patch("/api/v1/me", {"full_name": "اسم جديد"}, format="json", HTTP_X_CSRFTOKEN=c.cookies["csrftoken"].value)
        assert r.status_code == 200

    def test_native_login_returns_hashed_token(self, world):
        r = APIClient().post("/api/v1/auth/login", {"email": "s1@x.test", "password": PW, "client": "native"})
        raw = r.json()["token"]
        tok = AuthToken.objects.get(user=world.s1)
        assert raw not in tok.key_hash and len(tok.key_hash) == 64

    def test_wrong_password_generic_error_and_audited(self, world):
        r = APIClient().post("/api/v1/auth/login", {"email": "s1@x.test", "password": "nope"})
        assert r.status_code == 400 and r.json()["code"] == "bad_credentials"
        assert AuditEvent.objects.filter(action="auth.login_failed").exists()

    def test_admin_cannot_use_learning_login_and_student_cannot_use_admin_login(self, world):
        assert APIClient().post("/api/v1/auth/login", {"email": "admin@x.test", "password": PW}).json()["code"] == "admin_portal_only"
        assert APIClient().post("/api/v1/admin/auth/login", {"email": "s1@x.test", "password": PW}).json()["code"] == "not_admin"
        assert APIClient().post("/api/v1/admin/auth/login", {"email": "admin@x.test", "password": PW}).status_code == 200

    def test_logout_revokes_native_token(self, world):
        c = client_for(world.s1)
        assert c.post("/api/v1/auth/logout").status_code == 204
        assert c.get("/api/v1/me").status_code == 401

    def test_suspension_cuts_off_session_and_token(self, world):
        web = APIClient()
        web.post("/api/v1/auth/login", {"email": "s1@x.test", "password": PW})
        native = client_for(world.s1)
        r = client_for(world.admin).post(f"/api/v1/admin/users/{world.s1.pk}/status", {"status": "suspended", "reason": "اختبار"})
        assert r.status_code == 200
        assert web.get("/api/v1/me").status_code in (401, 403)
        assert native.get("/api/v1/me").status_code == 401
        r = APIClient().post("/api/v1/auth/login", {"email": "s1@x.test", "password": PW})
        assert r.json()["code"] == "account_suspended"

    def test_suspension_requires_reason(self, world):
        r = client_for(world.admin).post(f"/api/v1/admin/users/{world.s1.pk}/status", {"status": "suspended"})
        assert r.status_code == 400 and "reason" in r.json()["fields"]


@pytest.mark.django_db
def test_admin_mfa_flow(world):
    c = client_for(world.admin)
    secret = c.post("/api/v1/admin/mfa/setup").json()["secret"]
    assert c.post("/api/v1/admin/mfa/confirm", {"otp": "000000"}).status_code == 400
    code = totp._code(secret, int(__import__("time").time() // 30))
    assert c.post("/api/v1/admin/mfa/confirm", {"otp": code}).status_code == 200
    anon = APIClient()
    assert anon.post("/api/v1/admin/auth/login", {"email": "admin@x.test", "password": PW}).json()["code"] == "mfa_required"
    assert anon.post("/api/v1/admin/auth/login", {"email": "admin@x.test", "password": PW, "otp": "123456"}).status_code == 401
    assert anon.post("/api/v1/admin/auth/login", {"email": "admin@x.test", "password": PW, "otp": code}).status_code == 200


@pytest.mark.django_db
class TestRecovery:
    def test_forgot_is_generic(self, world):
        a = APIClient().post("/api/v1/auth/password/forgot", {"email": "s1@x.test"}).json()["message"]
        b = APIClient().post("/api/v1/auth/password/forgot", {"email": "nobody@x.test"}).json()["message"]
        assert a == b and len(mail.outbox) == 1

    def test_reset_with_emailed_token_then_old_tokens_revoked(self, world):
        native = client_for(world.s1)
        APIClient().post("/api/v1/auth/password/forgot", {"email": "s1@x.test"})
        link = mail.outbox[0].body.split("reset?")[1].split()[0]
        params = dict(p.split("=", 1) for p in link.split("&"))
        r = APIClient().post("/api/v1/auth/password/reset", {**params, "password": "a-brand-new-pass-77"})
        assert r.status_code == 200
        assert native.get("/api/v1/me").status_code == 401
        # The same link cannot be reused after the password changed.
        assert APIClient().post("/api/v1/auth/password/reset", {**params, "password": "another-new-pass-88"}).json()["code"] == "reset_invalid"


@pytest.mark.django_db
class TestInvitations:
    def test_teacher_invitation_creates_teacher_once(self, world):
        code = client_for(world.admin).post("/api/v1/invitations", {"purpose": "teacher_account", "email": "newt@x.test"}).json()["code"]
        body = {"code": code, "full_name": "معلم جديد", "email": "newt@x.test", "password": PW}
        assert APIClient().post("/api/v1/auth/invitations/accept", body).status_code == 201
        assert User.objects.get(email="newt@x.test").role == Role.TEACHER
        assert APIClient().post("/api/v1/auth/invitations/accept", {**body, "email": "other@x.test"}).json()["code"] == "invitation_invalid"

    def test_student_cannot_issue_teacher_invitation(self, world):
        r = client_for(world.s1).post("/api/v1/invitations", {"purpose": "teacher_account"})
        assert r.status_code == 403

    def test_guardian_link_via_invitation(self, world):
        p2 = make_user("p2@x.test", Role.PARENT)
        code = client_for(world.admin).post("/api/v1/invitations", {"purpose": "guardian_link", "student": world.s2.pk}).json()["code"]
        assert client_for(p2).post("/api/v1/auth/invitations/accept", {"code": code}).status_code == 201
        kids = client_for(p2).get("/api/v1/parent/children").json()["results"]
        assert [k["id"] for k in kids] == [world.s2.pk]

    def test_expired_invitation_fails(self, world):
        from datetime import timedelta
        from django.utils import timezone
        inv, raw = Invitation.issue(purpose="guardian_link", created_by=world.admin, student=world.s2)
        Invitation.objects.filter(pk=inv.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
        r = client_for(make_user("p3@x.test", Role.PARENT)).post("/api/v1/auth/invitations/accept", {"code": raw})
        assert r.json()["code"] == "invitation_invalid"
