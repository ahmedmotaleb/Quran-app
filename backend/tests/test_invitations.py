"""Pack prompt 37: invitations are emailed by the server; responses carry no code or link (unless the inviter asks for
the link to also send it over WhatsApp)."""
from datetime import timedelta

import pytest
from django.core import mail
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import AccountStatus, Invitation, Role, User
from apps.core.models import AuditEvent

from .conftest import PW, client_for, make_user

pytestmark = pytest.mark.django_db
URL = "/api/v1/invitations"


@pytest.fixture
def mailbox(settings):
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    from apps.accounts import emails

    real = emails.email_configured
    emails.email_configured = lambda: True
    yield mail.outbox
    emails.email_configured = real


def link_in(m) -> str:
    return next(w for w in m.body.split() if "#/invite?code=" in w)


def invite(user, **body):
    return client_for(user).post(URL, {"purpose": "teacher_account", **body}, format="json")


def test_admin_invites_teacher_by_email_without_exposing_the_code(world, mailbox, settings):
    r = invite(world.admin, email="New.T@x.test")
    assert r.status_code == 201
    d = r.json()
    assert d["email_sent"] is True and d["status"] == "pending" and d["email_status"] == "sent"
    assert "link" not in d and "code" not in d and "code=" not in str(d)
    m = mailbox[0]
    assert m.to == ["new.t@x.test"] and "كمعلم" in m.subject and m.alternatives[0][1] == "text/html"
    url = link_in(m)
    assert url.startswith(settings.FRONTEND_URL) and "صالح حتى" in m.body and "مرة واحدة" in m.body
    code = url.split("code=")[1]
    anon = APIClient()
    body = {"code": code, "full_name": "معلم جديد", "email": "new.t@x.test", "password": PW, "gender": "female"}
    assert anon.post("/api/v1/auth/invitations/accept", body, format="json").status_code == 201
    assert anon.post("/api/v1/auth/invitations/accept", {**body, "email": "x@x.test"}, format="json").status_code == 400  # one-time
    assert Invitation.objects.get(pk=d["id"]).status == "accepted"
    data = str(list(AuditEvent.objects.filter(action__startswith="invitation.").values_list("data", flat=True)))
    assert code not in data and "new.t@x.test" not in data and "x.test" in data  # domain only
    assert {"invitation.created", "invitation.email_sent", "invitation.accepted"} <= set(
        AuditEvent.objects.values_list("action", flat=True))


def test_share_link_only_when_asked_and_whatsapp_without_email(world, mailbox):
    d = invite(world.admin, email="wa.teacher@x.test", share_link=True).json()
    assert d["email_sent"] is True and "#/invite?code=" in d["link"]
    w = invite(world.admin, share_link=True).json()  # WhatsApp only: no address
    assert w["email_sent"] is False and "#/invite?code=" in w["link"] and len(mailbox) == 1
    assert invite(world.admin).status_code == 400  # neither an email nor a share request


def test_permissions_and_teacher_student_invitation(world, mailbox):
    assert invite(world.s1, email="a@x.test").status_code == 403
    assert invite(world.p1, email="a@x.test").status_code == 403
    assert invite(world.t1, email="a@x.test").status_code == 403  # teachers cannot invite teachers
    r = client_for(world.t1).post(URL, {"purpose": "student_teacher", "email": "kid@x.test"}, format="json")
    assert r.status_code == 201 and r.json()["email_sent"] and "حَلْقة" in mailbox[-1].subject
    g = client_for(world.admin).post(URL, {"purpose": "guardian_link", "email": "dad@x.test", "student": world.s1.pk}, format="json")
    assert g.status_code == 201 and mailbox[-1].subject == "دعوة ولي أمر إلى حَلْقة"
    assert "s1" not in mailbox[-1].body  # no child data in the email
    mine = client_for(world.t1).get(URL).json()["results"]
    assert [x["purpose"] for x in mine] == ["student_teacher"]  # a teacher lists only their own
    assert client_for(world.t2).post(f"{URL}/{r.json()['id']}/resend", format="json").status_code == 404  # IDOR
    assert client_for(world.s1).get(URL).status_code == 403


def test_existing_accounts_and_open_invitations(world, mailbox):
    assert invite(world.admin, email=world.t2.email).json()["code"] == "email_taken"
    sus = make_user("sus@x.test", Role.TEACHER)
    sus.status = AccountStatus.SUSPENDED
    sus.save()
    assert invite(world.admin, email="sus@x.test").json()["code"] == "account_inactive"
    first = invite(world.admin, email="dup@x.test").json()
    again = invite(world.admin, email="dup@x.test")
    assert again.status_code == 409 and again.json()["fields"]["invitation"] == [str(first["id"])]


def test_resend_replaces_the_code_and_is_throttled(world, mailbox):
    d = invite(world.admin, email="re@x.test").json()
    old_code = link_in(mailbox[0]).split("code=")[1]
    c = client_for(world.admin)
    assert c.post(f"{URL}/{d['id']}/resend", format="json").json()["code"] == "too_soon"
    Invitation.objects.filter(pk=d["id"]).update(last_sent_at=timezone.now() - timedelta(minutes=2))
    r = c.post(f"{URL}/{d['id']}/resend", format="json")
    assert r.status_code == 201 and r.json()["id"] != d["id"] and r.json()["send_count"] == 2 and "link" not in r.json()
    new_code = link_in(mailbox[1]).split("code=")[1]
    anon = APIClient()
    body = {"full_name": "معلم", "email": "re@x.test", "password": PW, "gender": "male"}
    assert anon.post("/api/v1/auth/invitations/accept", {**body, "code": old_code}, format="json").status_code == 400
    assert anon.post("/api/v1/auth/invitations/accept", {**body, "code": new_code}, format="json").status_code == 201
    listed = c.get(URL).json()["results"]
    assert [x["id"] for x in listed] == [r.json()["id"]]  # the replaced one is hidden
    assert AuditEvent.objects.filter(action="invitation.resent").exists()


def test_expired_and_revoked_invitations(world, mailbox):
    d = invite(world.admin, email="ex@x.test").json()
    code = link_in(mailbox[0]).split("code=")[1]
    Invitation.objects.filter(pk=d["id"]).update(expires_at=timezone.now() - timedelta(minutes=1))
    body = {"code": code, "full_name": "معلم", "email": "ex@x.test", "password": PW, "gender": "male"}
    assert APIClient().post("/api/v1/auth/invitations/accept", body, format="json").status_code == 400
    assert client_for(world.admin).get(f"{URL}?open=1").json()["results"][0]["status"] == "expired"
    Invitation.objects.filter(pk=d["id"]).update(last_sent_at=timezone.now() - timedelta(minutes=2))
    assert client_for(world.admin).post(f"{URL}/{d['id']}/resend", format="json").status_code == 201  # a fresh expiry
    new = Invitation.objects.latest("id")
    assert client_for(world.admin).post(f"{URL}/{new.pk}/revoke", format="json").json()["status"] == "revoked"
    assert AuditEvent.objects.filter(action="invitation.revoked").exists()


def test_failed_email_is_reported_truthfully(world, settings):
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"  # not a real delivery backend
    d = invite(world.admin, email="nomail@x.test").json()
    assert d["email_sent"] is False and d["status"] == "failed" and "link" not in d
    assert AuditEvent.objects.filter(action="invitation.email_failed").exists()


def test_setup_link_email_is_branded(world, mailbox):
    r = client_for(world.admin).post("/api/v1/admin/users", {"full_name": "ولي أمر", "email": "parent9@x.test", "role": "parent"},
                                     format="json").json()
    assert r["setup_email_sent"] is True and r["setup_link"] is None
    m = mailbox[-1]
    assert m.subject == "إعداد حسابك في حَلْقة" and "ولي أمر" in m.body and "next=parent" in m.body
    assert User.objects.get(email="parent9@x.test").role == Role.PARENT
