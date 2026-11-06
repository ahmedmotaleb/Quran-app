"""Preferred-teacher requests «اختر معلمك» and the reminder for students without a teacher."""
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.accounts.models import TeacherAssignment, TeacherProfile, TeacherRequest
from apps.accounts.teacher_requests import send_reminders
from apps.core.models import AppSettings, AuditEvent
from apps.notifications.models import Notification

from .conftest import client_for, make_user
from .test_admins import staff

pytestmark = pytest.mark.django_db
MINE = "/api/v1/student/teacher-request"
ADMIN = "/api/v1/admin/teacher-requests"


@pytest.fixture
def lone(world):
    """A student with no teacher."""
    return make_user("lone@x.test")


def test_student_requests_a_listed_teacher_once(world, lone, django_capture_on_commit_callbacks):
    c = client_for(lone)
    assert c.get(MINE).json() == {"has_teacher": False, "request": None}
    r = c.post(MINE, {"teacher": world.t1.pk, "note": "أفضّل المساء"}, format="json")
    assert r.status_code == 201 and r.json()["status"] == "pending" and r.json()["status_label"] == "بانتظار المراجعة"
    assert r.json()["teacher"]["name"] == world.t1.display_name
    assert c.post(MINE, {"teacher": world.t2.pk}, format="json").json()["code"] == "duplicate_request"   # one pending at a time
    assert TeacherRequest.objects.filter(student=lone).count() == 1
    assert not TeacherAssignment.objects.filter(student=lone).exists()                                  # never assigns by itself
    assert AuditEvent.objects.filter(action="student.teacher_requested").count() == 1


def test_suggest_a_teacher_not_listed_and_validation(world, lone):
    c = client_for(lone)
    assert c.post(MINE, {}, format="json").status_code == 400
    assert c.post(MINE, {"teacher": world.t1.pk, "suggested_name": "الشيخ فلان"}, format="json").status_code == 400  # one or the other
    assert c.post(MINE, {"suggested_name": "ab"}, format="json").status_code == 400
    TeacherProfile.objects.filter(user=world.t2).update(approved_at=None)
    assert "غير متاح" in str(c.post(MINE, {"teacher": world.t2.pk}, format="json").json()["fields"])     # unapproved teacher
    assert c.post(MINE, {"teacher": world.s2.pk}, format="json").status_code == 400                     # not a teacher
    r = c.post(MINE, {"suggested_name": "الشيخ محمود الحصري"}, format="json")
    assert r.status_code == 201 and r.json()["teacher"] is None and r.json()["suggested_name"] == "الشيخ محمود الحصري"


def test_only_students_without_a_teacher(world):
    assert client_for(world.s1).post(MINE, {"teacher": world.t2.pk}, format="json").json()["code"] == "has_teacher"
    assert client_for(world.t1).get(MINE).status_code == 403
    assert client_for(world.p1).post(MINE, {"teacher": world.t1.pk}, format="json").status_code == 403


def test_admin_approve_unavailable_with_alternative_then_assign(world, lone, django_capture_on_commit_callbacks):
    with django_capture_on_commit_callbacks(execute=True):
        rid = client_for(lone).post(MINE, {"teacher": world.t1.pk}, format="json").json()["id"]
    a = client_for(world.admin)
    rows = a.get(f"{ADMIN}?status=pending").json()["results"]
    assert rows[0]["student"]["name"] == lone.full_name and rows[0]["teacher"]["id"] == world.t1.pk
    with django_capture_on_commit_callbacks(execute=True):
        assert a.post(f"{ADMIN}/{rid}/decide", {"action": "approve"}, format="json").json()["status"] == "approved"
    with django_capture_on_commit_callbacks(execute=True):
        r = a.post(f"{ADMIN}/{rid}/decide", {"action": "unavailable", "teacher": world.t2.pk}, format="json").json()
    assert r["status"] == "unavailable" and r["alternative"]["id"] == world.t2.pk
    n = Notification.objects.get(recipient=lone, kind="teacher_request_unavailable")
    assert world.t2.display_name in n.body
    with django_capture_on_commit_callbacks(execute=True):
        r = a.post(f"{ADMIN}/{rid}/decide", {"action": "assign", "teacher": world.t2.pk}, format="json").json()
    assert r["status"] == "assigned" and r["assigned_teacher"]["id"] == world.t2.pk
    assert TeacherAssignment.objects.filter(student=lone, teacher=world.t2, active=True).exists()
    hist = a.get(f"{ADMIN}?status=assigned").json()["results"][0]["history"]   # notification history, read back
    assert [h["title"] for h in hist] == ["تمت الموافقة على طلب اختيار المعلم", "المعلم المطلوب غير متاح", "تم تعيين معلمك"]
    assert a.post(f"{ADMIN}/{rid}/decide", {"action": "approve"}, format="json").json()["code"] == "already_assigned"
    assert client_for(lone).get(MINE).json() == {"has_teacher": True, "request": None}


def test_assign_requested_teacher_and_permissions(world, lone):
    rid = client_for(lone).post(MINE, {"teacher": world.t1.pk}, format="json").json()["id"]
    sup = staff("sup@x.test", preset="support")                                    # may view teachers, not assign
    assert client_for(sup).get(ADMIN).status_code == 200
    assert client_for(sup).post(f"{ADMIN}/{rid}/decide", {"action": "assign"}, format="json").status_code == 403
    assert client_for(lone).get(ADMIN).status_code == 403
    a = client_for(world.admin)
    assert a.post(f"{ADMIN}/{rid}/decide", {"action": "assign", "teacher": world.s2.pk}, format="json").status_code == 400
    r = a.post(f"{ADMIN}/{rid}/decide", {"action": "assign"}, format="json").json()  # the requested teacher
    assert r["status"] == "assigned" and r["assigned_teacher"]["id"] == world.t1.pk
    assert AuditEvent.objects.filter(action="admin.teacher_request_decided").exists()


def test_a_suggested_name_needs_a_teacher_to_assign(world, lone):
    rid = client_for(lone).post(MINE, {"suggested_name": "معلم من خارج القائمة"}, format="json").json()["id"]
    a = client_for(world.admin)
    assert a.post(f"{ADMIN}/{rid}/decide", {"action": "assign"}, format="json").status_code == 400
    assert a.post(f"{ADMIN}/{rid}/decide", {"action": "assign", "teacher": world.t2.pk}, format="json").json()["status"] == "assigned"


def test_assignment_from_the_student_record_closes_the_request(world, lone, django_capture_on_commit_callbacks):
    rid = client_for(lone).post(MINE, {"teacher": world.t1.pk}, format="json").json()["id"]
    with django_capture_on_commit_callbacks(execute=True):
        r = client_for(world.admin).post("/api/v1/admin/teacher-assignments", {"teacher": world.t2.pk, "student": lone.pk}, format="json")
    assert r.status_code == 201
    t = TeacherRequest.objects.get(pk=rid)
    assert t.status == "assigned" and t.assigned_teacher == world.t2


def test_reminder_every_48h_only_without_a_teacher(world, lone, django_capture_on_commit_callbacks):
    now = timezone.now()
    assert send_reminders(now)["pick"] == 1                                        # lone has no teacher; s1/s2 do
    n = Notification.objects.get(recipient=lone, kind="teacher_pick")
    assert n.title == "اختر معلمك"
    assert send_reminders(now + timedelta(hours=1)) == {"pick": 0, "pending": 0}   # still unread: no duplicate
    n.read_at = now; n.save(update_fields=["read_at"])
    assert send_reminders(now + timedelta(hours=47))["pick"] == 0                  # read, but not 48 hours yet
    later = now + timedelta(hours=49)
    assert send_reminders(later)["pick"] == 1                                      # 48 hours later: once more
    now = later + timedelta(hours=49)
    # A pending request changes the reminder to «طلبك قيد المراجعة».
    Notification.objects.filter(recipient=lone).update(read_at=now, created_at=now - timedelta(hours=49))
    client_for(lone).post(MINE, {"teacher": world.t1.pk}, format="json")
    assert send_reminders(now) == {"pick": 0, "pending": 1}
    assert Notification.objects.filter(recipient=lone, kind="teacher_pick_pending").get().title == "طلبك قيد المراجعة"
    # Assigned: the unread reminder is cleared and no more come.
    with django_capture_on_commit_callbacks(execute=True):
        TeacherAssignment.objects.create(teacher=world.t1, student=lone)
    assert not Notification.objects.filter(recipient=lone, kind__startswith="teacher_pick", read_at__isnull=True).exists()
    Notification.objects.filter(recipient=lone).update(created_at=now - timedelta(hours=200))
    assert send_reminders(now) == {"pick": 0, "pending": 0}


def test_reminder_frequency_is_an_admin_setting(world, lone):
    s = AppSettings.load(); s.teacher_reminder_hours = 0; s.save()
    assert send_reminders() == {"pick": 0, "pending": 0}                           # 0 = off
    r = client_for(world.admin).patch("/api/v1/admin/settings", {"teacher_reminder_hours": 24}, format="json")
    assert r.status_code == 200 and r.json()["teacher_reminder_hours"] == 24
    assert client_for(world.admin).patch("/api/v1/admin/settings", {"teacher_reminder_hours": 400}, format="json").status_code == 400
    assert send_reminders()["pick"] == 1
