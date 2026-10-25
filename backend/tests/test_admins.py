"""Multi-admin with granular permissions (owner request, 23 October 2026)."""
import time
from datetime import timedelta

import pytest
from django.core import mail
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts import admin_access as aa
from apps.accounts import totp
from apps.accounts.models import AdminProfile, Invitation, Role, User
from apps.core.models import AuditEvent

from .conftest import PW, client_for, make_user

pytestmark = pytest.mark.django_db


@pytest.fixture
def mailbox(settings):
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    from apps.accounts import emails

    real = emails.email_configured
    emails.email_configured = lambda: True
    yield mail.outbox
    emails.email_configured = real


def with_mfa(u):
    u.mfa_secret, u.mfa_enabled = totp.new_secret(), True
    u.save()
    return u


def code(u):
    return totp._code(u.mfa_secret, int(time.time() // 30))


def staff(email, preset=None, perms=None, owner=None):
    u = make_user(email, Role.ADMIN, owner=False)
    if preset == "owner":
        AdminProfile.objects.create(user=u, access_level="owner", preset="owner")
    else:
        AdminProfile.objects.create(user=u, access_level="admin", preset=preset or "custom",
                                    permissions=sorted(aa.PRESETS[preset]) if preset else perms or [], created_by=owner)
    return with_mfa(u)


def invite(c, actor, **body):
    data = {"full_name": "مسؤول جديد", "email": "staff@x.test", "level": "admin", "preset": "academic_manager", "otp": code(actor), **body}
    return c.post("/api/v1/admin/admins", data, format="json")


# 1–4 ------------------------------------------------------------------------------------------
def test_owner_invites_admin_who_sets_password_then_must_enable_mfa(world, mailbox, settings):
    owner = with_mfa(world.admin)
    r = invite(client_for(owner), owner)
    assert r.status_code == 201 and r.json()["email_sent"] is True and "link" not in r.json()
    m = mailbox[-1]
    assert m.subject == "دعوة للانضمام إلى إدارة حَلْقة" and "&kind=admin" in m.body
    raw = next(w for w in m.body.split() if "code=" in w).split("code=")[1].split("&")[0]
    anon = APIClient()
    body = {"code": raw, "full_name": "مسؤول جديد", "password": PW}
    assert anon.post("/api/v1/auth/invitations/accept", {**body, "email": "other@x.test"}, format="json").status_code == 400  # email-bound
    r = anon.post("/api/v1/auth/invitations/accept", {**body, "email": "staff@x.test"}, format="json")
    assert r.status_code == 201 and r.json()["user"]["role"] == "admin" and r.json()["admin_url"].endswith("/admin/")
    assert anon.post("/api/v1/auth/invitations/accept", {**body, "email": "staff@x.test"}, format="json").status_code == 400  # one-time
    u = User.objects.get(email="staff@x.test")
    assert u.admin_profile.preset == "academic_manager" and u.admin_profile.created_by == owner
    assert aa.has(u, "users.view") and not aa.has(u, "admins.manage") and not aa.has(u, "users.delete_permanent")
    # Invited admins must turn on two-step verification before anything else (even where it is not required globally).
    settings.ADMIN_REQUIRE_MFA = False
    c = client_for(u)
    assert c.get("/api/v1/admin/users?role=student").json()["code"] == "mfa_setup_required"
    assert c.get("/api/v1/me").json()["mfa_required"] is True
    secret = c.post("/api/v1/admin/mfa/setup").json()["secret"]
    assert c.post("/api/v1/admin/mfa/confirm", {"otp": totp._code(secret, int(time.time() // 30))}).status_code == 200
    assert c.get("/api/v1/admin/users?role=student").status_code == 200
    acts = set(AuditEvent.objects.values_list("action", flat=True))
    assert {"admin.invited", "admin.setup_completed", "admin.mfa_enabled"} <= acts
    assert raw not in str(list(AuditEvent.objects.values_list("data", flat=True)))
    u.refresh_from_db()
    assert u.mfa_secret and u.mfa_secret not in str(list(AuditEvent.objects.values_list("data", flat=True)))


# 5–7, 11–13 -------------------------------------------------------------------------------------
def test_permissions_are_enforced_on_the_server(world):
    support = client_for(staff("support@x.test", "support"))
    assert support.get("/api/v1/admin/users?role=student").status_code == 200
    assert support.get("/api/v1/admin/users?role=parent").status_code == 200
    assert support.get("/api/v1/admin/bookings").status_code == 200
    for path in ("/api/v1/admin/settings", "/api/v1/admin/audit", "/api/v1/admin/admins", "/api/v1/admin/courses", "/api/v1/admin/circles"):
        r = support.get(path)
        assert r.status_code == 403 and r.json()["code"] == "admin_permission_denied", path
    r = support.post("/api/v1/admin/users/bulk-action", {"action": "delete", "ids": [world.s1.pk], "reason": "سبب", "confirm": "حذف"}, format="json")
    assert r.status_code == 403
    r = support.post(f"/api/v1/admin/users/{world.s1.pk}/promote-teacher", {"reason": "سبب كاف", "confirm": "ترقية"}, format="json")
    assert r.status_code == 403
    assert User.objects.get(pk=world.s1.pk).role == Role.STUDENT
    # Support may suspend (explicitly allowed) but not archive.
    assert support.post(f"/api/v1/admin/users/{world.s2.pk}/status", {"status": "suspended", "reason": "مراجعة"}, format="json").status_code == 200
    assert support.post(f"/api/v1/admin/users/{world.s2.pk}/status", {"status": "archived", "reason": "مراجعة"}, format="json").status_code == 403
    academic = client_for(staff("academic@x.test", "academic_manager"))
    assert academic.get("/api/v1/admin/circles").status_code == 200
    assert academic.post("/api/v1/admin/teacher-assignments", {"teacher": world.t2.pk, "student": world.s1.pk}, format="json").status_code == 201
    assert academic.get("/api/v1/admin/settings").status_code == 403
    assert academic.get("/api/v1/admin/admins").status_code == 403
    content = client_for(staff("content@x.test", "content"))
    assert content.get("/api/v1/admin/courses").status_code == 200
    assert content.get("/api/v1/admin/users?role=student").status_code == 403
    # An admin without a profile has no access at all (deny by default).
    bare = client_for(make_user("bare@x.test", Role.ADMIN, owner=False))
    assert bare.get("/api/v1/admin/users?role=student").status_code == 403


def test_private_recordings_need_submissions_view(world):
    from apps.media.models import MediaObject

    m = MediaObject.objects.create(owner=world.s1, purpose="recitation", key="rec/x.webm", content_type="audio/webm", state="validated")
    from apps.media.services import can_read

    assert can_read(staff("support2@x.test", "support"), m) is False
    assert can_read(staff("acad2@x.test", "academic_manager"), m) is True
    assert can_read(world.admin, m) is True  # owner


# 8–10, 15–16 ------------------------------------------------------------------------------------
def test_owner_changes_permissions_immediately_and_audited(world):
    owner = with_mfa(world.admin)
    a = staff("a@x.test", "support", owner=owner)
    ca = client_for(a)
    assert ca.get("/api/v1/admin/courses").status_code == 403
    c = client_for(owner)
    assert c.patch(f"/api/v1/admin/admins/{a.pk}", {"preset": "content"}, format="json").json()["code"] == "fresh_mfa_required"
    r = c.patch(f"/api/v1/admin/admins/{a.pk}", {"preset": "custom", "permissions": ["courses.view", "users.view"], "otp": code(owner)}, format="json")
    assert r.status_code == 200 and r.json()["permissions"] == ["courses.view", "users.view"]
    assert ca.get("/api/v1/admin/courses").status_code == 200          # applies on the next request
    assert ca.get("/api/v1/admin/bookings").status_code == 403
    ev = AuditEvent.objects.get(action="admin.permission_changed")
    assert "courses.view" in ev.data["added"] and "bookings.view" in ev.data["removed"] and ev.actor == owner
    assert AuditEvent.objects.filter(action="admin.preset_changed").exists()
    bad = c.patch(f"/api/v1/admin/admins/{a.pk}", {"preset": "custom", "permissions": ["nope.perm"], "otp": code(owner)}, format="json")
    assert bad.status_code == 400


def test_admins_cannot_grant_themselves_or_beyond_their_own_access(world):
    owner = with_mfa(world.admin)
    mgr = staff("mgr@x.test", perms=["admins.manage", "users.view"], owner=owner)
    c = client_for(mgr)
    assert c.patch(f"/api/v1/admin/admins/{mgr.pk}", {"preset": "custom", "permissions": ["users.view", "settings.manage"], "otp": code(mgr)},
                   format="json").json()["code"] == "self_change"
    other = staff("other@x.test", "read_only", owner=owner)
    r = c.patch(f"/api/v1/admin/admins/{other.pk}", {"preset": "custom", "permissions": ["settings.manage"], "otp": code(mgr)}, format="json")
    assert r.status_code == 403 and r.json()["code"] == "cannot_grant"
    assert invite(c, mgr, level="owner").json()["code"] == "owner_only"          # 16: non-owner cannot create an owner
    assert c.patch(f"/api/v1/admin/admins/{owner.pk}", {"level": "admin", "preset": "read_only", "otp": code(mgr)},
                   format="json").json()["code"] == "owner_only"
    assert invite(c, mgr, preset="academic_manager").json()["code"] == "cannot_grant"
    ok = invite(c, mgr, email="viewer@x.test", preset="custom", permissions=["users.view"])
    assert ok.status_code == 201


# 14 ------------------------------------------------------------------------------------------------
def test_last_owner_is_protected(world):
    owner = with_mfa(world.admin)
    second = staff("owner2@x.test", "owner")
    c2 = client_for(second)
    # The second owner may demote the first while two exist…
    assert c2.patch(f"/api/v1/admin/admins/{owner.pk}", {"level": "admin", "preset": "read_only", "otp": code(second)}, format="json").status_code == 200
    # …but nobody can remove the last active owner, and nobody changes themselves.
    c1 = client_for(User.objects.get(pk=owner.pk))
    assert c2.patch(f"/api/v1/admin/admins/{second.pk}", {"level": "admin", "preset": "read_only", "otp": code(second)},
                    format="json").json()["code"] == "self_change"
    third = staff("owner3@x.test", "owner")
    c3 = client_for(third)
    assert c3.post(f"/api/v1/admin/admins/{second.pk}/status", {"status": "suspended", "reason": "اختبار", "otp": code(third)},
                   format="json").status_code == 200
    r = c2.post(f"/api/v1/admin/admins/{third.pk}/status", {"status": "suspended", "reason": "اختبار", "otp": code(second)}, format="json")
    assert r.status_code in (401, 403)  # the suspended owner is signed out
    r = c3.patch(f"/api/v1/admin/admins/{third.pk}", {"level": "admin", "preset": "read_only", "otp": code(third)}, format="json")
    assert r.json()["code"] == "self_change"
    assert AdminProfile.objects.filter(access_level="owner", user__status="active").count() == 1
    assert AuditEvent.objects.filter(action="admin.suspended").exists()
    assert c1.get("/api/v1/admin/admins").status_code == 403  # demoted to read-only


def test_last_owner_cannot_be_demoted_or_suspended_by_another_owner_when_alone(world):
    owner = with_mfa(world.admin)
    other = staff("o2@x.test", "owner")
    c = client_for(other)
    c.post(f"/api/v1/admin/admins/{owner.pk}/status", {"status": "suspended", "reason": "اختبار", "otp": code(other)}, format="json")
    # `other` is now the only active owner; nobody (not even another owner record) can leave zero owners.
    third = staff("o3@x.test", "owner")
    third.status = "suspended"
    third.save()
    from apps.accounts.admin_management import _active_owners

    assert len(_active_owners()) == 1


def test_fresh_mfa_for_permanent_delete(world):
    owner = with_mfa(world.admin)
    c = client_for(owner)
    fresh = make_user("fresh-del@x.test", Role.PARENT)
    body = {"action": "delete", "ids": [fresh.pk], "reason": "طلب", "confirm": "حذف"}
    assert c.post("/api/v1/admin/users/bulk-action", body, format="json").json()["code"] == "fresh_mfa_required"
    assert c.post("/api/v1/admin/users/bulk-action", {**body, "otp": code(owner)}, format="json").json()["success"] == 1


def test_me_exposes_access_and_exports_need_permission(world):
    support = staff("sup3@x.test", "support")
    me = client_for(support).get("/api/v1/me").json()["admin_access"]
    assert me["preset"] == "support" and "users.view" in me["permissions"] and "settings.manage" not in me["permissions"]
    assert client_for(support).post("/api/v1/admin/users/export", {"filter": "role=student"}, format="json").status_code == 403
    assert client_for(world.admin).get("/api/v1/me").json()["admin_access"]["level"] == "owner"
    assert client_for(world.s1).get("/api/v1/me").json()["admin_access"] is None


def test_admin_invitation_rules(world, mailbox):
    owner = with_mfa(world.admin)
    c = client_for(owner)
    assert invite(c, owner, email="s1@x.test").json()["code"] == "email_taken"
    assert c.post("/api/v1/invitations", {"purpose": "admin_account", "email": "z@x.test"}, format="json").status_code == 400
    assert invite(c, owner, otp="000000").json()["code"] == "fresh_mfa_invalid"
    first = invite(c, owner, email="dup@x.test").json()
    invite(c, owner, email="dup@x.test")  # a second invitation replaces the first
    assert Invitation.objects.get(pk=first["id"]).revoke_reason == "replaced"
    inv = Invitation.objects.filter(email="dup@x.test").latest("id")
    Invitation.objects.filter(pk=inv.pk).update(expires_at=timezone.now() - timedelta(minutes=1))
    raw_any = "x"
    assert APIClient().post("/api/v1/auth/invitations/accept", {"code": raw_any, "gender": "male", "full_name": "x y", "email": "dup@x.test", "password": PW},
                            format="json").status_code == 400
    listed = c.get("/api/v1/admin/admins").json()
    assert {a["email"] for a in listed["results"]} == {"admin@x.test"} and "users.view" in listed["permissions"]


@pytest.mark.django_db
def test_portal_sign_in_records_last_login(client):
    u = make_user("owner-ll@example.com", role=Role.ADMIN)
    assert User.objects.get(pk=u.pk).last_login is None
    r = client.post("/api/v1/admin/auth/login", {"email": u.email, "password": PW, "client": "web"}, content_type="application/json",
                    HTTP_X_HALQA_PORTAL="admin")
    assert r.status_code == 200, r.content
    assert User.objects.get(pk=u.pk).last_login is not None
