"""Teacher onboarding (owner request 23 Oct 2026): «دعوة معلم» creates the account at once and emails a setup link;
Forgot Password works from the start; the admin sees delivery and can resend; approval stays separate."""
import re
from io import StringIO

import pytest
from django.core import mail
from django.core.management import call_command
from rest_framework.test import APIClient

from apps.accounts.models import Invitation, Role, TeacherProfile, User
from apps.core.models import AuditEvent

from .conftest import PW, client_for, make_user

A = "/api/v1/admin"


@pytest.fixture
def mailbox(settings):
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    from apps.accounts import emails

    real = emails.email_configured
    emails.email_configured = lambda: True
    yield mail.outbox
    emails.email_configured = real


def link_in(m):
    return re.search(r"https?://\S*#/reset\?\S+", m.body).group(0)


def reset_with(link, password=PW):
    q = dict(x.split("=", 1) for x in link.split("?", 1)[1].split("&") if "=" in x)
    return APIClient().post("/api/v1/auth/password/reset", {"uid": q["uid"], "token": q["token"], "password": password}, format="json")


def login(email, password=PW):
    return APIClient().post("/api/v1/auth/login", {"identifier": email, "password": password, "client": "native"}, format="json")


# 1–12 ------------------------------------------------------------------------------------------
def test_admin_creates_teacher_who_sets_password_signs_in_and_waits_for_approval(world, mailbox):
    admin = client_for(world.admin)
    r = admin.post(f"{A}/teachers", {"full_name": "عبدالرحمن", "email": "Teacher@Example.com"}, format="json")
    assert r.status_code == 201, r.content
    d = r.json()
    assert d["setup_email_sent"] is True and d["sent_to"] == "teacher@example.com" and "setup_link" not in d
    t = User.objects.get(email="teacher@example.com")
    assert t.role == Role.TEACHER and t.full_name == "عبدالرحمن" and not t.has_usable_password()
    assert TeacherProfile.objects.get(user=t).approved_at is None
    assert (t.setup_email_status, t.setup_email_count) == ("sent", 1) and t.setup_email_last_at
    m = mailbox[-1]
    assert m.subject == "إعداد حساب المعلم في حَلْقة" and "تم إنشاء حساب معلم لك في منصة حَلْقة." in m.body and "تعيين كلمة المرور" in m.body
    link = link_in(m)
    assert "#/reset?uid=" in link
    assert login("teacher@example.com").status_code == 400  # no password yet
    assert reset_with(link).status_code == 200
    r = login("teacher@example.com")
    assert r.status_code == 200 and r.json()["user"]["role"] == "teacher" and r.json()["user"]["teacher_approved"] is False
    # Not offered to students until approved.
    assert t.pk not in [x["id"] for x in client_for(world.s1).get("/api/v1/teachers").json()["results"]]
    assert admin.post(f"{A}/teachers/{t.pk}/approval", {"approved": True}, format="json").status_code == 200
    assert client_for(t).get("/api/v1/me").json()["teacher_approved"] is True
    assert t.pk in [x["id"] for x in client_for(world.s1).get("/api/v1/teachers").json()["results"]]
    assert AuditEvent.objects.filter(action="admin.teacher_created", target_id=str(t.pk)).exists()


# 13–17 -----------------------------------------------------------------------------------------
def test_teacher_who_ignored_the_email_uses_forgot_password(world, mailbox):
    client_for(world.admin).post(f"{A}/teachers", {"full_name": "معلم ناسٍ", "email": "lost@example.com"}, format="json")
    n = len(mailbox)
    assert APIClient().post("/api/v1/auth/password/forgot", {"email": "lost@example.com"}, format="json").status_code == 200
    assert len(mailbox) == n + 1
    assert reset_with(link_in(mailbox[-1])).status_code == 200
    assert login("lost@example.com").status_code == 200


# 18–20 -----------------------------------------------------------------------------------------
def test_admin_resends_setup_and_links_stop_working_once_the_password_is_set(world, mailbox):
    from django.utils import timezone

    admin = client_for(world.admin)
    t_id = admin.post(f"{A}/teachers", {"full_name": "معلم", "email": "again@example.com"}, format="json").json()["id"]
    first = link_in(mailbox[-1])
    assert admin.post(f"{A}/users/{t_id}/setup-link", format="json").status_code == 429  # just sent
    User.objects.filter(pk=t_id).update(setup_email_last_at=timezone.now() - timezone.timedelta(minutes=2))
    r = admin.post(f"{A}/users/{t_id}/setup-link", format="json").json()
    assert r["setup_email_sent"] is True and r["sent_to"] == "again@example.com" and r["setup_link"] is None
    second = link_in(mailbox[-1])
    assert User.objects.get(pk=t_id).setup_email_count == 2
    p = admin.get(f"{A}/users/{t_id}").json()
    assert p["has_password"] is False and p["setup_email_status"] == "sent" and p["setup_email_count"] == 2 and p["approved"] is False
    assert reset_with(second).status_code == 200
    assert reset_with(first, PW + "x").status_code == 400 and reset_with(second, PW + "x").status_code == 400  # used up


def test_failed_email_is_shown_and_only_the_owner_may_copy_a_link(world, settings):
    from apps.accounts.models import AdminProfile

    admin = client_for(world.admin)
    r = admin.post(f"{A}/teachers", {"full_name": "معلم", "email": "nomail@example.com"}, format="json").json()
    assert r["setup_email_sent"] is False and r["setup_email_status"] == "failed"
    support = make_user("sup-t@x.test", Role.ADMIN, owner=False)
    AdminProfile.objects.create(user=support, access_level="admin", preset="support", permissions=["invitations.send", "teachers.view"])
    assert client_for(support).post(f"{A}/users/{r['id']}/setup-link", {"share": True}, format="json").json()["setup_link"] is None
    assert "#/reset?uid=" in admin.post(f"{A}/users/{r['id']}/setup-link", {"share": True}, format="json").json()["setup_link"]


def test_no_duplicate_accounts_and_students_go_through_promotion(world, mailbox):
    admin = client_for(world.admin)
    assert admin.post(f"{A}/teachers", {"full_name": "x y", "email": world.s1.email}, format="json").json()["code"] == "existing_student"
    assert admin.post(f"{A}/teachers", {"full_name": "x y", "email": world.t1.email}, format="json").json()["code"] == "teacher_exists"
    assert admin.post(f"{A}/teachers", {"full_name": "x y", "email": world.admin.email}, format="json").json()["code"] == "email_is_admin"
    assert admin.post(f"{A}/teachers", {"full_name": "x y", "email": world.p1.email}, format="json").json()["code"] == "email_taken"
    assert client_for(world.s1).post(f"{A}/teachers", {"full_name": "x y", "email": "z@x.test"}, format="json").status_code == 403
    assert User.objects.filter(email=world.s1.email).count() == 1 and User.objects.get(pk=world.s1.pk).role == Role.STUDENT


def test_open_invitations_are_migrated_once(world, mailbox):
    open_new, _ = Invitation.issue(purpose=Invitation.Purpose.TEACHER_ACCOUNT, created_by=world.admin, days=7, email="old@example.com")
    Invitation.issue(purpose=Invitation.Purpose.TEACHER_ACCOUNT, created_by=world.admin, days=7, email=world.s2.email)
    out = StringIO()
    call_command("migrate_teacher_invitations", stdout=out)  # dry run
    assert not User.objects.filter(email="old@example.com").exists() and '"accounts_created": 1' in out.getvalue()
    call_command("migrate_teacher_invitations", "--apply", stdout=StringIO())
    t = User.objects.get(email="old@example.com")
    assert t.role == Role.TEACHER and not t.has_usable_password() and TeacherProfile.objects.get(user=t).approved_at is None
    assert mailbox[-1].to == ["old@example.com"] and mailbox[-1].subject == "إعداد حساب المعلم في حَلْقة"
    open_new.refresh_from_db()
    assert open_new.revoke_reason == "replaced"
    assert User.objects.get(pk=world.s2.pk).role == Role.STUDENT  # left for «ترقية إلى معلم»
    call_command("migrate_teacher_invitations", "--apply", stdout=StringIO())
    assert User.objects.filter(email="old@example.com").count() == 1
