"""Pack prompt 36: admin operations on top of the bulk framework — export, assign teacher, enroll, in-app message,
resend setup email, saved views, archive/restore."""
import csv
import io

import pytest
from django.core import mail
from django.utils import timezone

from apps.accounts.models import AccountStatus, TeacherAssignment, TeacherProfile
from apps.core.models import AuditEvent, SavedView
from apps.learning.models import Course, Enrollment, PublishState
from apps.notifications.models import Notification
from apps.notifications.push import payload_for

from .conftest import client_for, make_user

pytestmark = pytest.mark.django_db
A = "/api/v1/admin"


def act(c, resource, **body):
    return c.post(f"{A}/{resource}/bulk-action", body, format="json")


def rows(r):
    assert r.status_code == 200 and r["Content-Type"].startswith("text/csv")
    text = r.content.decode("utf-8")
    assert text.startswith("﻿")
    return list(csv.reader(io.StringIO(text[1:])))


# ---- export ----------------------------------------------------------------------------------
def test_export_selected_and_filtered_rows_as_arabic_csv(world):
    admin = client_for(world.admin)
    world.s2.full_name = "=HYPERLINK(\"http://evil\")"
    world.s2.save()
    sel = rows(admin.post(f"{A}/users/export", {"ids": [world.s1.id]}, format="json"))
    assert sel[0][:3] == ["الرقم", "الاسم", "البريد"] and len(sel) == 2 and sel[1][1] == world.s1.full_name
    allst = rows(admin.post(f"{A}/users/export", {"filter": {"role": "student"}, "sort": "name"}, format="json"))
    assert len(allst) == 3 and any(r[1].startswith("'=") for r in allst[1:])  # formula neutralised
    assert "t1" in allst[1][7] or "t1" in allst[2][7]  # teachers column
    ev = AuditEvent.objects.filter(action="admin.export").latest("created_at")
    assert ev.data["rows"] == 2 and ev.data["mode"] == "filter"


def test_export_is_admin_only_and_never_includes_private_fields(world):
    for who in (world.s1, world.t1, world.p1):
        assert client_for(who).post(f"{A}/users/export", {"ids": [world.s1.id]}, format="json").status_code == 403
    text = client_for(world.admin).post(f"{A}/bookings/export", {"filter": {}}, format="json").content.decode()
    assert "الطالب" in text and "note" not in text
    assert client_for(world.admin).post(f"{A}/nope/export", {"ids": [1]}, format="json").status_code == 404
    assert client_for(world.admin).post(f"{A}/users/export", {"filter": {"bogus": 1}}, format="json").status_code == 400


# ---- assign teacher --------------------------------------------------------------------------
def test_bulk_assign_teacher_validates_teacher_and_reports_per_record(world):
    admin = client_for(world.admin)
    t3 = make_user("t3@x.test", role="teacher")
    TeacherProfile.objects.filter(user=t3).update(approved_at=None)
    r = act(admin, "users", action="assign_teacher", ids=[world.s1.id], params={"teacher": t3.id})
    assert r.status_code == 400 and r.json()["fields"]["teacher"]
    r = act(admin, "users", action="assign_teacher", ids=[world.s1.id, world.s2.id, world.p1.id], params={"teacher": world.t1.id}).json()
    assert (r["success"], r["skipped"], r["failed"]) == (1, 1, 1)  # s2 added; s1 already; parent refused
    assert TeacherAssignment.objects.filter(student=world.s2, active=True).count() == 2
    r = act(admin, "users", action="assign_teacher", ids=[world.s2.id], params={"teacher": world.t1.id, "replace": True}).json()
    assert r["success"] == 1
    assert list(TeacherAssignment.objects.filter(student=world.s2, active=True).values_list("teacher", flat=True)) == [world.t1.id]
    ev = AuditEvent.objects.filter(action="admin.bulk_assign_teacher").latest("created_at")
    assert ev.data["params"] == {"teacher": world.t1.id, "replace": True}


# ---- enroll ----------------------------------------------------------------------------------
def test_mass_enrollment_skips_existing_and_refuses_archived_course(world):
    admin = client_for(world.admin)
    c = Course.objects.create(title="التجويد", teacher=world.t1, state=PublishState.PUBLISHED)
    Enrollment.objects.create(course=c, student=world.s1)
    r = act(admin, "users", action="enroll", filter={"role": "student"}, expected=2, params={"course": c.id}).json()
    assert (r["success"], r["skipped"]) == (1, 1)
    assert Enrollment.objects.filter(course=c, status="active").count() == 2
    old = Course.objects.create(title="قديمة", teacher=world.t1, state=PublishState.ARCHIVED)
    assert act(admin, "users", action="enroll", ids=[world.s1.id], params={"course": old.id}).status_code == 400
    # The cohort filter selects the course's students (e.g. to message them).
    assert admin.get(f"{A}/users", {"role": "student", "course": c.id}).json()["count"] == 2


# ---- message -----------------------------------------------------------------------------------
def test_bulk_message_in_app_with_generic_push(world, django_capture_on_commit_callbacks):
    admin = client_for(world.admin)
    assert act(admin, "users", action="notify", ids=[world.s1.id], params={"title": "x", "body": "مرحبا"}).status_code == 400
    with django_capture_on_commit_callbacks(execute=True):
        r = act(admin, "users", action="notify", ids=[world.s1.id, world.p1.id],
                params={"title": "تنبيه من الإدارة", "body": "الحلقة غدًا بعد العصر"}).json()
    assert r["success"] == 2
    n = Notification.objects.get(recipient=world.s1, kind="admin_message")
    assert n.title == "تنبيه من الإدارة" and n.body == "الحلقة غدًا بعد العصر"
    push = payload_for(n.kind, n.link)
    assert "الحلقة غدًا" not in push["body"] and "تنبيه" not in push["title"]  # lock screen stays generic
    ev = AuditEvent.objects.get(action="admin.bulk_notify")
    assert ev.actor == world.admin and ev.data["success"] == 2 and "الحلقة غدًا" not in str(ev.data)


# ---- resend setup ------------------------------------------------------------------------------
def test_resend_setup_emails_only_users_without_password(world, settings):
    admin = client_for(world.admin)
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    assert act(admin, "users", action="resend_setup", ids=[world.s1.id]).json()["code"] == "email_off"
    settings.EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
    fresh = make_user("fresh@x.test")
    fresh.set_unusable_password()
    fresh.save()
    from unittest import mock

    with mock.patch("django.core.mail.send_mail", return_value=1) as sm:
        r = act(admin, "users", action="resend_setup", ids=[fresh.id, world.s1.id]).json()
        assert (r["success"], r["skipped"]) == (1, 1) and sm.call_count == 1
        assert "token=" in sm.call_args.args[1] and "token" not in str(r)
        again = act(admin, "users", action="resend_setup", ids=[fresh.id]).json()
        assert again["skipped"] == 1 and again["results"][0]["code"] == "recently_sent"
    assert len(mail.outbox) == 0
    assert "token" not in str(AuditEvent.objects.filter(action="admin.setup_link_issued").values_list("data", flat=True))


# ---- saved views -------------------------------------------------------------------------------
def test_saved_views_are_validated_and_private(world):
    admin = client_for(world.admin)
    r = admin.post(f"{A}/saved-views", {"section": "students", "name": "طلاب بدون معلم", "query": "?unlinked=1&sort=-joined&page=3"}, format="json")
    assert r.status_code == 201 and r.json()["query"] == "unlinked=1&sort=-joined"
    assert admin.post(f"{A}/saved-views", {"section": "students", "name": "طلاب بدون معلم", "query": ""}, format="json").status_code == 409
    assert admin.post(f"{A}/saved-views", {"section": "students", "name": "سيئ", "query": "evil=1"}, format="json").status_code == 400
    assert admin.post(f"{A}/saved-views", {"section": "students", "name": "سيئ", "query": "sort=password"}, format="json").status_code == 400
    assert admin.post(f"{A}/saved-views", {"section": "nope", "name": "سيئ", "query": ""}, format="json").status_code == 400
    other = make_user("admin2@x.test", role="admin", is_staff=True)
    assert client_for(other).get(f"{A}/saved-views").json() == []
    vid = r.json()["id"]
    assert client_for(other).delete(f"{A}/saved-views/{vid}").status_code == 404
    assert admin.get(f"{A}/saved-views?section=students").json()[0]["name"] == "طلاب بدون معلم"
    assert admin.delete(f"{A}/saved-views/{vid}").status_code == 204 and not SavedView.objects.exists()
    assert client_for(world.t1).get(f"{A}/saved-views").status_code == 403


# ---- archive / restore -------------------------------------------------------------------------
def test_archived_list_and_restore_are_audited(world):
    admin = client_for(world.admin)
    assert act(admin, "users", action="archive", ids=[world.s2.id], reason="طلب الأسرة").json()["success"] == 1
    assert admin.get(f"{A}/users", {"role": "student"}).json()["count"] == 1  # hidden from the normal list
    archived = admin.get(f"{A}/users", {"role": "student", "status": "archived"}).json()
    assert [u["id"] for u in archived["results"]] == [world.s2.id]
    assert act(admin, "users", action="activate", reason="مراجعة الحساب", ids=[world.s2.id]).json()["success"] == 1
    world.s2.refresh_from_db()
    assert world.s2.status == AccountStatus.ACTIVE
    assert AuditEvent.objects.filter(action="admin.bulk_activate").exists()
    assert timezone.now()
