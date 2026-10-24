"""Teacher + admin on the same account (owner request, 24 October 2026): the role stays «معلم», an AdminProfile adds
admin access, which is used only through the admin portal's own session (admin login, two-step verification)."""
import pytest
from rest_framework.test import APIClient

from apps.accounts import admin_access as aa
from apps.accounts.models import AccountStatus, AdminProfile, Role, TeacherAssignment, TrustedDevice, User
from apps.core.models import AuditEvent
from apps.notifications.models import Notification

from .conftest import PW, client_for, make_user
from .test_admins import code, mailbox, staff, with_mfa  # noqa: F401  (fixture)

pytestmark = pytest.mark.django_db
NOT_ADMIN = "هذا الحساب لا يملك صلاحية الدخول إلى لوحة الإدارة."


def portal(u, *, otp=None, client="web"):
    """Sign in at the admin login with the portal's own session (as the portal does)."""
    c = APIClient()
    c.credentials(HTTP_X_HALQA_PORTAL="admin")
    body = {"email": u.email, "password": PW, "client": client}
    if otp is not None or u.mfa_enabled:
        body["otp"] = otp if otp is not None else code(u)
    return c, c.post("/api/v1/admin/auth/login", body, format="json")


def grant(actor, teacher, *, preset="academic_manager", level="admin", perms=None, otp=True):
    data = {"teacher": teacher.pk, "level": level, "preset": preset, "permissions": perms or []}
    if otp:
        data["otp"] = code(actor)
    return client_for(actor).post("/api/v1/admin/admins/grant-teacher-access", data, format="json")


def access(actor, teacher, action, reason="انتهت المهمة الإدارية"):
    return client_for(actor).post(f"/api/v1/admin/admins/{teacher.pk}/access",
                                  {"action": action, "reason": reason, "otp": code(actor)}, format="json")


@pytest.fixture
def owner(world):
    return with_mfa(world.admin)


def dual(world, owner, preset="academic_manager", **kw):
    assert grant(owner, world.t1, preset=preset, **kw).status_code == 201
    return with_mfa(User.objects.get(pk=world.t1.pk))


# 1–5: granting -------------------------------------------------------------------------------------------------
def test_owner_grants_teacher_admin_access_keeping_everything(world, owner, django_capture_on_commit_callbacks):
    with django_capture_on_commit_callbacks(execute=True):
        r = grant(owner, world.t1)
    assert r.status_code == 201 and r.json()["teacher_admin"] is True and r.json()["preset"] == "academic_manager"
    t = User.objects.get(pk=world.t1.pk)
    assert t.role == Role.TEACHER and t.status == AccountStatus.ACTIVE      # never changed to admin
    assert TeacherAssignment.objects.filter(teacher=t, student=world.s1, active=True).exists()
    assert t.admin_profile.created_by_id == owner.pk and aa.mfa_required(t)
    ev = AuditEvent.objects.get(action="admin.access_granted_to_teacher")
    assert ev.actor_id == owner.pk and ev.data["preset"] == "academic_manager"
    n = Notification.objects.get(recipient=t, kind="admin_access_granted")
    assert n.title == "تم منحك صلاحية الدخول إلى لوحة إدارة حَلْقة." and "التحقق بخطوتين" in n.body
    assert "reset" not in n.link and "token" not in n.link                     # no password-setup link


def test_grant_needs_admins_manage_and_fresh_mfa(world, owner):
    r = grant(owner, world.t1, otp=False)
    assert r.status_code == 403 and r.json()["code"] == "fresh_mfa_required"
    sup = staff("sup@x.test", preset="support", owner=owner)
    assert grant(sup, world.t1).status_code == 403
    assert not AdminProfile.objects.filter(user=world.t1).exists()


def test_owner_level_only_by_owner_and_no_permissions_beyond_own(world, owner):
    mgr = staff("mgr@x.test", perms=["admins.manage", "users.view"], owner=owner)
    assert grant(mgr, world.t1, level="owner", preset="owner").json()["code"] == "owner_only"
    r = grant(mgr, world.t1, preset="custom", perms=["users.view", "settings.manage"])
    assert r.status_code == 403 and r.json()["code"] == "cannot_grant"
    assert grant(mgr, world.t1, preset="custom", perms=["users.view"]).status_code == 201


def test_only_existing_active_teachers_and_once(world, owner):
    assert grant(owner, world.s1).status_code == 404
    assert grant(owner, world.p1).status_code == 404
    assert grant(owner, world.t1).status_code == 201
    assert grant(owner, world.t1).json()["code"] == "already_admin"
    world.t2.status = AccountStatus.SUSPENDED
    world.t2.save()
    assert grant(owner, world.t2).json()["code"] == "account_inactive"


def test_candidate_search_by_name_email_phone_excludes_admins(world, owner):
    world.t2.full_name, world.t2.phone = "الشيخ يوسف", "+201001234567"
    world.t2.save()
    grant(owner, world.t1)
    c = client_for(owner)
    ids = lambda q: [x["id"] for x in c.get("/api/v1/admin/admins/teacher-candidates", {"q": q}).json()["results"]]  # noqa: E731
    assert ids("يوسف") == [world.t2.pk] and ids("t2@x") == [world.t2.pk] and ids("1234567") == [world.t2.pk]
    assert world.t1.pk not in ids("")                     # already has admin access
    assert world.s1.pk not in ids("s1")
    assert client_for(staff("ro@x.test", preset="read_only", owner=owner)).get("/api/v1/admin/admins/teacher-candidates").status_code == 403


# 6–11: signing in and the two contexts ---------------------------------------------------------------------------
def test_teacher_without_admin_access_is_refused_at_admin_login(world):
    _, r = portal(world.t1)
    assert r.status_code == 403 and r.json()["code"] == "not_admin" and r.json()["message"] == NOT_ADMIN
    _, r = portal(world.s1)
    assert r.json()["code"] == "not_admin"


def test_teacher_admin_must_set_up_mfa_then_uses_portal(world, owner):
    grant(owner, world.t1)
    t = User.objects.get(pk=world.t1.pk)
    c, r = portal(t)
    assert r.status_code == 200 and r.json()["user"]["role"] == "teacher"
    assert c.get("/api/v1/admin/users").json()["code"] == "mfa_setup_required"
    with_mfa(t)
    _, r = portal(t, otp="")
    assert r.json()["code"] == "mfa_required"            # the existing authenticator is used at sign-in
    c, r = portal(t)
    assert r.status_code == 200
    assert c.get("/api/v1/admin/users", {"role": "student"}).status_code == 200
    assert c.get("/api/v1/admin/excuses").status_code == 200
    me = c.get("/api/v1/me").json()
    assert me["role"] == "teacher" and me["admin_access"]["teacher_admin"] is True


def test_permissions_follow_the_profile(world, owner):
    t = dual(world, owner, preset="content")
    c, _ = portal(t)
    assert c.get("/api/v1/admin/users", {"role": "student"}).status_code == 403   # content preset: no users.view
    assert c.patch("/api/v1/admin/settings", {"join_minutes": 5}, format="json").status_code == 403


def test_teacher_app_session_never_reaches_admin_apis(world, owner):
    t = dual(world, owner, preset="owner", level="owner")
    app = client_for(t)                                   # the teacher app's token
    assert app.get("/api/v1/admin/users").status_code == 403
    assert app.get("/api/v1/admin/excuses").status_code == 403
    assert app.get("/api/v1/teacher/excuses").status_code == 200   # still a teacher there
    me = app.get("/api/v1/me").json()
    assert me["role"] == "teacher" and me["admin_access"]["active"] is True
    # The learners' sign-in keeps working for the teacher (a role=admin account is sent to the portal instead).
    r = APIClient().post("/api/v1/auth/login", {"email": t.email, "password": PW, "client": "native"}, format="json")
    assert r.status_code == 200 and r.json()["user"]["role"] == "teacher"


def test_teacher_admin_cannot_get_an_admin_app_token(world, owner):
    t = dual(world, owner)
    _, r = portal(t, client="native")
    assert r.status_code == 403 and r.json()["code"] == "not_admin"


def test_portal_context_acts_as_admin_and_teacher_app_does_not(world, owner):
    t = dual(world, owner)
    assert aa.acts_as_admin(t) is False
    assert TeacherAssignment.objects.filter(teacher=t).count() == 1
    c, _ = portal(t)
    rows = c.get("/api/v1/admin/users", {"role": "student"}).json()["results"]
    assert {u["id"] for u in rows} >= {world.s1.pk, world.s2.pk}     # all students, not only the teacher's own


# 12–16: pausing and removing ------------------------------------------------------------------------------------
def test_suspend_and_reactivate_admin_access_only(world, owner, django_capture_on_commit_callbacks):
    t = dual(world, owner)
    c, _ = portal(t)
    assert c.get("/api/v1/admin/excuses").status_code == 200
    with django_capture_on_commit_callbacks(execute=True):
        r = access(owner, t, "suspend")
    assert r.status_code == 200 and r.json()["access_active"] is False
    assert c.get("/api/v1/admin/excuses").status_code in (401, 403)   # the portal session ends at once
    assert portal(t)[1].json()["code"] == "not_admin"
    assert client_for(t).get("/api/v1/teacher/excuses").status_code == 200   # the teacher account works
    assert User.objects.get(pk=t.pk).status == AccountStatus.ACTIVE
    assert AuditEvent.objects.filter(action="admin.access_suspended", target_id=str(t.pk)).exists()
    assert access(owner, t, "suspend").json()["code"] == "unchanged"
    assert access(owner, t, "reactivate", reason="").status_code == 200
    assert AuditEvent.objects.filter(action="admin.access_reactivated").exists()
    assert portal(t)[1].status_code == 200


def test_remove_admin_access_keeps_teacher_account(world, owner, django_capture_on_commit_callbacks):
    t = dual(world, owner)
    c, _ = portal(t)
    TrustedDevice.objects.create(user=t, token_hash="x" * 64, marker="m", expires_at="2099-01-01T00:00:00Z")
    assert access(owner, t, "remove", reason="").json()["code"] == "invalid"       # a reason is required
    with django_capture_on_commit_callbacks(execute=True):
        r = access(owner, t, "remove")
    assert r.status_code == 200 and r.json()["removed"] is True
    t = User.objects.get(pk=t.pk)
    assert t.role == Role.TEACHER and t.status == AccountStatus.ACTIVE and not AdminProfile.objects.filter(user=t).exists()
    assert TeacherAssignment.objects.filter(teacher=t, student=world.s1, active=True).exists()
    assert c.get("/api/v1/admin/excuses").status_code in (401, 403)
    assert not TrustedDevice.objects.filter(user=t, revoked_at__isnull=True).exists()
    assert AuditEvent.objects.filter(action="admin.access_removed_from_teacher", target_id=str(t.pk)).exists()
    assert Notification.objects.filter(recipient=t, kind="admin_access_remove").exists()
    assert client_for(t).get("/api/v1/me").json()["admin_access"] is None


def test_access_changes_need_fresh_mfa_and_owner_rules(world, owner):
    t = dual(world, owner, preset="owner", level="owner")
    r = client_for(owner).post(f"/api/v1/admin/admins/{t.pk}/access", {"action": "remove", "reason": "سبب"}, format="json")
    assert r.json()["code"] == "fresh_mfa_required"
    mgr = staff("mgr@x.test", preset="academic_manager", owner=owner)
    AdminProfile.objects.filter(user=mgr).update(permissions=sorted(aa.PRESETS["academic_manager"] | {"admins.manage"}))
    assert access(mgr, t, "remove").json()["code"] == "owner_only"            # an owner's access: owners only
    c, _ = portal(t)
    r = c.post(f"/api/v1/admin/admins/{t.pk}/access", {"action": "remove", "reason": "سبب", "otp": code(t)}, format="json")
    assert r.json()["code"] == "self_change"                                  # never on oneself
    assert AdminProfile.objects.filter(user=t).exists()


def test_last_active_owner_is_protected(world, owner):
    t = dual(world, owner, preset="owner", level="owner")
    # The traditional owner leaves: the teacher is now the only active owner.
    owner.status = AccountStatus.SUSPENDED
    owner.save()
    other = staff("own2@x.test", preset="owner")
    AdminProfile.objects.filter(user=other).update(is_active=False)          # an owner whose access is paused
    assert aa.is_owner(User.objects.get(pk=other.pk)) is False
    from apps.accounts.admin_management import _active_owners
    assert [p.user_id for p in _active_owners()] == [t.pk]
    assert aa.holder_guard(t, t, new_status="suspended") == "لا يمكنك تغيير حالة حسابك بنفسك."


def test_admin_list_labels_and_account_status_endpoint(world, owner):
    t = dual(world, owner)
    rows = {r["email"]: r for r in client_for(owner).get("/api/v1/admin/admins").json()["results"]}
    assert rows["t1@x.test"]["teacher_admin"] is True and rows["admin@x.test"]["teacher_admin"] is False
    assert "t2@x.test" not in rows
    r = client_for(owner).post(f"/api/v1/admin/admins/{t.pk}/status", {"status": "suspended", "reason": "سبب", "otp": code(owner)}, format="json")
    assert r.status_code == 409 and r.json()["code"] == "teacher_admin"
    r = client_for(owner).patch(f"/api/v1/admin/admins/{t.pk}", {"level": "admin", "preset": "support", "otp": code(owner)}, format="json")
    assert r.status_code == 200 and r.json()["preset"] == "support"


# 17–20: other paths ----------------------------------------------------------------------------------------------
def test_invite_with_a_teacher_email_offers_grant(world, owner, mailbox):
    r = client_for(owner).post("/api/v1/admin/admins", {"full_name": "معلم", "email": "t1@x.test", "level": "admin",
                                                        "preset": "support", "otp": code(owner)}, format="json")
    assert r.status_code == 409 and r.json()["code"] == "teacher_exists"
    assert r.json()["message"] == "هذا البريد يخص معلمًا موجودًا. يمكنك منحه صلاحيات الإدارة من حسابه الحالي."
    assert r.json()["fields"]["user"] == [str(world.t1.pk)] and mailbox == []


def test_people_pages_protect_a_teacher_with_admin_access(world, owner):
    t = dual(world, owner)
    sup = staff("sup@x.test", preset="support", owner=owner)                   # has users.suspend, not admins.manage
    r = client_for(sup).post(f"/api/v1/admin/users/{t.pk}/status", {"status": "suspended", "reason": "سبب"}, format="json")
    assert r.status_code == 403 and r.json()["code"] == "admin_holder"
    r = client_for(sup).post("/api/v1/admin/users/bulk-action", {"action": "suspend", "ids": [t.pk], "reason": "سبب"}, format="json")
    assert r.status_code == 200 and r.json()["failed"] and User.objects.get(pk=t.pk).status == AccountStatus.ACTIVE
    pre = client_for(owner).get(f"/api/v1/admin/users/{t.pk}/delete-preflight").json()
    assert pre["deletable"] is False


def test_perms_come_from_the_profile_not_the_role(world, owner):
    assert aa.perms_of(world.t1) == frozenset() and aa.has_admin_access(world.t1) is False
    assert aa.has_admin_access(world.s1) is False and aa.has_admin_access(world.p1) is False
    t = dual(world, owner, preset="support")
    assert aa.perms_of(t) == aa.PRESETS["support"] and aa.has_admin_access(t)
    AdminProfile.objects.filter(user=t).update(is_active=False)
    t = User.objects.get(pk=t.pk)
    assert aa.perms_of(t) == frozenset() and not aa.has_admin_access(t) and aa.access_out(t)["active"] is False
    # A traditional admin without a profile still signs in (no permissions: deny by default).
    legacy = make_user("legacy@x.test", Role.ADMIN, owner=False)
    assert aa.has_admin_access(legacy) and aa.perms_of(legacy) == frozenset()
    # Students and parents never get admin access, even with a stray profile.
    AdminProfile.objects.create(user=world.s1, access_level="owner", preset="owner")
    assert aa.has_admin_access(User.objects.get(pk=world.s1.pk)) is False


def test_suspended_teacher_account_has_no_admin_access(world, owner):
    t = dual(world, owner)
    t.status = AccountStatus.SUSPENDED
    t.save()
    assert portal(t)[1].json()["code"] == "account_suspended"
    assert aa.has_admin_access(t) is False
