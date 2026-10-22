"""Permanent account deletion (owner decision 22 October 2026): personal data erased, educational records kept anonymous;
accounts with no activity removed completely."""
import io
from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.erase import DELETED_NAME
from apps.accounts.models import (
    AccountStatus,
    AuthToken,
    GuardianLink,
    LinkStatus,
    Role,
    TeacherAssignment,
    User,
)
from apps.core.models import AuditEvent
from apps.learning.models import Assignment, Submission
from apps.media.models import MediaObject
from apps.media.storage import get_storage
from apps.notifications.models import Notification

from .conftest import PW, client_for, make_user, occurrence

pytestmark = pytest.mark.django_db
BULK = "/api/v1/admin/users/bulk-action"


def delete(admin, ids, **kw):
    body = {"action": "delete", "ids": ids, "reason": "طلب ولي الأمر", "confirm": "حذف", **kw}
    return client_for(admin).post(BULK, body, format="json")


def recording(student, teacher):
    a = Assignment.objects.create(student=student, teacher=teacher, kind="hifz", title="حفظ سورة الملك", surah=67,
                                  ayah_from=1, ayah_to=10, due_at=timezone.now() + timedelta(days=1))
    key = f"rec/test-{a.pk}.webm"
    get_storage().save(key, io.BytesIO(b"audio"), "audio/webm")
    m = MediaObject.objects.create(owner=student, purpose="recitation", key=key, content_type="audio/webm",
                                   state=MediaObject.State.VALIDATED)
    Submission.objects.create(assignment=a, student=student, media=m, attempt=1, duration_seconds=30, idempotency_key=f"k{a.pk}")
    return a, m


def test_account_without_activity_is_removed_completely(world):
    fresh = make_user("fresh@x.test", Role.PARENT)
    r = delete(world.admin, [fresh.pk])
    assert r.status_code == 200 and r.json()["success"] == 1
    assert not User.objects.filter(pk=fresh.pk).exists()
    ev = AuditEvent.objects.get(action="admin.user_deleted")
    assert ev.target_id == str(fresh.pk) and ev.data["mode"] == "removed" and "fresh" not in str(ev.data)


def test_student_with_history_is_anonymized_and_records_kept(world):
    s = world.s1
    a, m = recording(s, world.t1)
    Notification.objects.create(recipient=s, kind="x", title="t", body="b")
    s.phone = "01000000000"
    s.save()
    r = delete(world.admin, [s.pk])
    assert r.json()["success"] == 1, r.json()
    s.refresh_from_db()
    assert s.full_name == DELETED_NAME and s.email == f"deleted-{s.pk}@deleted.invalid" and s.phone == ""
    assert s.status == AccountStatus.DELETED and not s.is_active and not s.has_usable_password()
    assert not AuthToken.objects.filter(user=s).exists() and not Notification.objects.filter(recipient=s).exists()
    m.refresh_from_db()
    assert m.state == MediaObject.State.DELETED
    with pytest.raises(OSError):
        get_storage().open(m.key)  # the recording's bytes are gone
    assert Assignment.objects.filter(pk=a.pk).exists() and Submission.objects.filter(media=m).exists()  # history kept
    assert not TeacherAssignment.objects.filter(student=s, active=True).exists()
    assert GuardianLink.objects.get(pk=world.link.pk).status == LinkStatus.REVOKED
    ev = AuditEvent.objects.get(action="admin.user_deleted")
    assert ev.data == {"role": "student", "mode": "anonymized", "recordings_removed": 1}
    # The teacher still sees the task, under the anonymous name.
    rows = client_for(world.t1).get("/api/v1/assignments").json()
    assert DELETED_NAME in str(rows) and "s1@x.test" not in str(rows)


def test_deleted_account_cannot_sign_in_recover_or_be_reactivated(world):
    recording(world.s1, world.t1)
    old_client = client_for(world.s1)
    delete(world.admin, [world.s1.pk])
    assert old_client.get("/api/v1/me").status_code in (401, 403)
    anon = APIClient()
    assert anon.post("/api/v1/auth/login", {"email": "s1@x.test", "password": PW, "client": "native"}, format="json").status_code in (400, 401, 403)
    ad = client_for(world.admin)
    assert ad.post(f"/api/v1/admin/users/{world.s1.pk}/status", {"status": "active"}, format="json").status_code == 404
    assert ad.get(f"/api/v1/admin/users/{world.s1.pk}").status_code == 404
    listed = ad.get("/api/v1/admin/users?role=student&status=archived").json()
    assert world.s1.pk not in [u["id"] for u in listed.get("results", listed)]
    assert "deleted" not in ad.get("/api/v1/admin/users/counts?role=student").json()
    again = delete(world.admin, [world.s1.pk]).json()
    assert again["success"] == 0 and again["failed"] == 1  # gone from the admin's view
    # The email can be used for a new account.
    assert make_user("s1@x.test").pk != world.s1.pk


def test_confirmation_reason_admins_and_permissions(world):
    c = client_for(world.admin)
    assert c.post(BULK, {"action": "delete", "ids": [world.p1.pk], "reason": "سبب"}, format="json").json()["code"] == "confirm_required"
    assert c.post(BULK, {"action": "delete", "ids": [world.p1.pk], "confirm": "حذف"}, format="json").status_code == 400  # reason
    other_admin = make_user("admin2@x.test", Role.ADMIN)
    assert delete(world.admin, [other_admin.pk]).json()["success"] == 0
    assert User.objects.filter(pk=other_admin.pk).exists()
    for u in (world.t1, world.s1, world.p1):
        assert client_for(u).post(BULK, {"action": "delete", "ids": [world.s2.pk], "reason": "x y z", "confirm": "حذف"},
                                  format="json").status_code == 403
    assert User.objects.get(pk=world.s2.pk).status == AccountStatus.ACTIVE


def test_teacher_with_upcoming_sessions_is_refused_then_deleted(world):
    o = occurrence(world.t2)
    r = delete(world.admin, [world.t2.pk]).json()
    assert r["failed"] == 1 and r["errors"][0]["code"] == "upcoming_sessions"
    o.status = "cancelled"
    o.save()
    assert delete(world.admin, [world.t2.pk]).json()["success"] == 1
    t = User.objects.get(pk=world.t2.pk)
    assert t.full_name == DELETED_NAME and t.teacher_profile.bio == "" and t.status == AccountStatus.DELETED
    assert not TeacherAssignment.objects.filter(teacher=t, active=True).exists()
