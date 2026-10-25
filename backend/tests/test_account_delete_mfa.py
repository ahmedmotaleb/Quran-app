"""Permanent delete as production runs it (24 Oct fix): admin MFA enforced, a current authenticator code with every
delete, private files on S3/R2 removed in one batch as the last step (a storage failure rolls everything back), a
teacher's upcoming sessions handled explicitly, per-record results, and no personal data in the audit trail."""
import io
import json
from datetime import timedelta

import pytest
from botocore.stub import Stubber
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import AccountStatus, AuthToken, Role, TeacherAssignment, User
from apps.core.models import AuditEvent
from apps.learning.models import Assignment, Submission
from apps.media import storage as storage_mod
from apps.media.models import MediaObject
from apps.media.storage import get_storage
from apps.notifications.models import Notification
from apps.scheduling.models import Booking, SessionOccurrence

from .conftest import PW, client_for, make_user, occurrence
from .test_admins import code, staff, with_mfa

pytestmark = pytest.mark.django_db
BULK = "/api/v1/admin/users/bulk-action"


@pytest.fixture(autouse=True)
def _production_like(settings, tmp_path):
    settings.ADMIN_REQUIRE_MFA = True
    settings.MEDIA_STORAGE = "local"
    settings.MEDIA_LOCAL_ROOT = tmp_path / "media"


@pytest.fixture
def owner(world):
    return with_mfa(world.admin)  # the owner (all permissions) with two-step verification, as in production


def body(ids, **kw):
    return {"action": "delete", "ids": ids, "reason": "طلب حذف الحساب", "confirm": "حذف", **kw}


def delete(admin, ids, **kw):
    return client_for(admin).post(BULK, body(ids, **kw), format="json")


def with_recording(student, teacher, key=None):
    a = Assignment.objects.create(student=student, teacher=teacher, kind="hifz", title="حفظ سورة الملك", surah=67,
                                  ayah_from=1, ayah_to=10, due_at=timezone.now() + timedelta(days=1))
    key = key or f"recitation/{student.pk}/rec-{a.pk}.webm"
    get_storage().save(key, io.BytesIO(b"audio"), "audio/webm")
    m = MediaObject.objects.create(owner=student, purpose="recitation", key=key, content_type="audio/webm",
                                   state=MediaObject.State.VALIDATED)
    Submission.objects.create(assignment=a, student=student, media=m, attempt=1, duration_seconds=30, idempotency_key=f"k{a.pk}")
    return a, m


def login(email):
    return APIClient().post("/api/v1/auth/login", {"email": email, "password": PW, "client": "native"}, format="json")


# 9–11: fresh MFA ---------------------------------------------------------------------------------------------------
def test_fresh_mfa_missing_invalid_valid(world, owner):
    p = make_user("p-mfa@x.test", Role.PARENT)
    r = delete(owner, [p.pk])
    assert r.status_code == 403 and r.json()["code"] == "fresh_mfa_required"
    assert r.json()["message"] == "أدخل رمز التحقق الحالي من تطبيق المصادقة."
    r = delete(owner, [p.pk], otp="000000")
    assert r.status_code == 403 and r.json()["code"] == "fresh_mfa_invalid"
    assert r.json()["message"] == "رمز التحقق غير صحيح. أدخل الرمز الحالي وحاول مرة أخرى."
    assert User.objects.filter(pk=p.pk).exists()  # nothing happened before a valid code
    r = delete(owner, [p.pk], otp=code(owner))
    assert r.status_code == 200 and r.json()["success"] == 1 and r.json()["mode"] == "removed"


# 1, 5, 13: parent with no history is removed; the email can be used again -----------------------------------------
def test_parent_without_history_is_removed_and_email_reusable(world, owner):
    p = make_user("reuse@x.test", Role.PARENT)
    r = delete(owner, [p.pk], otp=code(owner))
    assert {k: r.json()[k] for k in ("success", "failed", "mode")} == {"success": 1, "failed": 0, "mode": "removed"}
    assert r.json()["done"] == [{"id": p.pk, "label": p.full_name, "result": {"mode": "removed"}}]
    assert not User.objects.filter(pk=p.pk).exists()
    assert client_for(owner).get("/api/v1/admin/users?role=parent").json()["count"] == 1  # only the fixture parent
    r = APIClient().post("/api/v1/auth/register", {"gender": "male", "full_name": "حساب جديد", "email": "reuse@x.test", "password": "a-new-strong-pass-77"}, format="json")
    assert r.status_code == 201


# 2, 3, 4, 5, 7(spec 7): student with history is anonymized; recording removed from storage; cannot sign in ----------
def test_student_with_history_is_anonymized(world, owner):
    s = world.s1
    a, m = with_recording(s, world.t1)
    s.phone = "+201012345678"
    s.save()
    AuthToken.issue(s, device="phone")
    Notification.objects.create(recipient=s, kind="assignment_new", title="t", dedupe_key="d1")
    r = delete(owner, [s.pk], otp=code(owner))
    assert r.json()["success"] == 1 and r.json()["mode"] == "anonymized"
    s.refresh_from_db()
    assert s.full_name == "حساب محذوف" and s.email.endswith("@deleted.invalid") and s.phone == ""
    assert not s.has_usable_password() and not s.mfa_enabled and s.mfa_secret == ""
    assert s.status == AccountStatus.DELETED and s.is_active is False
    assert not AuthToken.objects.filter(user=s).exists() and not Notification.objects.filter(recipient=s).exists()
    assert Assignment.objects.filter(pk=a.pk).exists() and Submission.objects.filter(media=m).exists()  # history kept
    m.refresh_from_db()
    assert m.state == MediaObject.State.DELETED and not (get_storage().root / m.key).exists()
    assert login("s1@x.test").status_code in (400, 401, 403)
    assert APIClient().post("/api/v1/auth/register", {"gender": "male", "full_name": "طالب جديد", "email": "s1@x.test", "password": "a-new-strong-pass-77"},
                            format="json").status_code == 201
    # The list no longer shows it, and it cannot be restored.
    rows = client_for(owner).get("/api/v1/admin/users?role=student").json()["results"]
    assert s.pk not in [x["id"] for x in rows]
    r = client_for(owner).post(BULK, {"action": "activate", "ids": [s.pk], "reason": "استعادة"}, format="json")
    assert r.json()["success"] == 0 and r.json()["errors"][0]["code"] == "not_found"


# 6–8: reason and typed confirmation -----------------------------------------------------------------------------------
def test_reason_and_confirmation_required(world, owner):
    p = make_user("p-rc@x.test", Role.PARENT)
    c = client_for(owner)
    assert c.post(BULK, body([p.pk], reason="", otp=code(owner)), format="json").status_code == 400
    b = body([p.pk], otp=code(owner))
    b.pop("confirm")
    assert c.post(BULK, b, format="json").json()["code"] == "confirm_required"
    assert c.post(BULK, body([p.pk], confirm="حذفف", otp=code(owner)), format="json").json()["code"] == "confirm_required"
    assert User.objects.filter(pk=p.pk).exists()


# 12–13: permissions -----------------------------------------------------------------------------------------------
def test_admin_without_delete_permission_is_refused(world, owner):
    p = make_user("p-perm@x.test", Role.PARENT)
    mgr = staff("mgr-del@x.test", "academic_manager")  # every academic permission, not permanent delete
    r = delete(mgr, [p.pk], otp=code(mgr))
    assert r.status_code == 403 and r.json()["message"] == "ليس لديك صلاحية الحذف النهائي."
    granted = staff("del-ok@x.test", perms=["users.view", "users.delete_permanent"])
    assert delete(granted, [p.pk], otp=code(granted)).json()["success"] == 1
    assert client_for(mgr).get(f"/api/v1/admin/users/{world.s1.pk}/delete-preflight").status_code == 403


# 14–15: a teacher's upcoming sessions ---------------------------------------------------------------------------
def test_teacher_upcoming_sessions_preflight_block_then_cancel_and_delete(world, owner, django_capture_on_commit_callbacks):
    t = world.t2
    past = occurrence(t, in_hours=-48)
    Booking.objects.create(occurrence=past, student=world.s2, idempotency_key="past", attendance="present")
    soon = occurrence(t, in_hours=30)
    later = occurrence(t, in_hours=80)
    b = Booking.objects.create(occurrence=soon, student=world.s2, idempotency_key="soon")
    pre = client_for(owner).get(f"/api/v1/admin/users/{t.pk}/delete-preflight").json()
    assert pre["upcoming_sessions"] == 2 and pre["upcoming_bookings"] == 1 and pre["mode"] == "anonymized"
    r = delete(owner, [t.pk], otp=code(owner))
    assert r.json()["success"] == 0 and r.json()["errors"][0]["code"] == "upcoming_sessions"
    assert r.json()["errors"][0]["message"].startswith("لا يمكن حذف هذا المعلم قبل معالجة جلساته القادمة.")
    with django_capture_on_commit_callbacks(execute=True):
        r = delete(owner, [t.pk], otp=code(owner), params={"cancel_sessions": True})
    assert r.json()["success"] == 1 and r.json()["mode"] == "anonymized"
    for o in (soon, later):
        o.refresh_from_db()
        assert o.status == SessionOccurrence.Status.CANCELLED
    b.refresh_from_db()
    past.refresh_from_db()
    assert b.status == Booking.Status.CANCELLED and past.status == SessionOccurrence.Status.SCHEDULED  # history kept
    assert Notification.objects.filter(recipient=world.s2).exists()  # the student was told
    assert AuditEvent.objects.get(action="admin.user_deleted").data["sessions_cancelled"] == 2


# 16: storage failure (production-like S3/R2 client) rolls everything back ---------------------------------------
@override_settings(MEDIA_STORAGE="s3", STORAGE_BUCKET="halqa-test", STORAGE_ACCESS_KEY_ID="k", STORAGE_SECRET_ACCESS_KEY="s",
                   STORAGE_ENDPOINT_URL="https://acct.r2.cloudflarestorage.com", STORAGE_REGION="auto")
@pytest.mark.parametrize("failure", ["client_error", "partial"])
def test_storage_failure_leaves_the_account_untouched(world, owner, monkeypatch, failure):
    s3 = storage_mod.S3Storage()
    stub = Stubber(s3.client)
    if failure == "client_error":
        stub.add_client_error("delete_objects", service_error_code="AccessDenied", http_status_code=403)
    else:
        stub.add_response("delete_objects", {"Errors": [{"Key": "x", "Code": "InternalError", "Message": "secret detail"}]})
    stub.activate()
    monkeypatch.setattr(storage_mod, "get_storage", lambda: s3)
    s = world.s1
    m = MediaObject.objects.create(owner=s, purpose="recitation", key=f"recitation/{s.pk}/x.webm", content_type="audio/webm",
                                   state=MediaObject.State.VALIDATED)
    a = Assignment.objects.create(student=s, teacher=world.t1, kind="hifz", title="t", surah=1, ayah_from=1, ayah_to=7,
                                  due_at=timezone.now() + timedelta(days=1))
    Submission.objects.create(assignment=a, student=s, media=m, attempt=1, duration_seconds=30, idempotency_key="kk")
    r = delete(owner, [s.pk], otp=code(owner))
    assert r.status_code == 200 and r.json()["success"] == 0
    err = r.json()["errors"][0]
    assert err["code"] == "storage_failed"
    assert err["message"] == "تعذر حذف الملفات الصوتية المرتبطة بالحساب. لم يتم حذف الحساب. حاول مرة أخرى."
    s.refresh_from_db()
    m.refresh_from_db()
    assert s.full_name != "حساب محذوف" and s.status == AccountStatus.ACTIVE and s.email == "s1@x.test"  # rolled back
    assert m.state == MediaObject.State.VALIDATED and TeacherAssignment.objects.filter(student=s, active=True).exists()
    assert not AuditEvent.objects.filter(action="admin.user_deleted").exists()
    assert "secret detail" not in json.dumps(r.json())
    stub.assert_no_pending_responses()


def test_storage_deletes_many_files_in_one_batch(world, owner, monkeypatch):
    calls = []

    class FakeS3:
        def delete_many(self, keys):
            calls.append(list(keys))

    monkeypatch.setattr(storage_mod, "get_storage", lambda: FakeS3())
    s = world.s1
    for i in range(25):
        MediaObject.objects.create(owner=s, purpose="recitation", key=f"recitation/{s.pk}/{i}.webm", content_type="audio/webm",
                                   state="validated")
    Assignment.objects.create(student=s, teacher=world.t1, kind="hifz", title="t", surah=1, ayah_from=1, ayah_to=7,
                              due_at=timezone.now())
    assert delete(owner, [s.pk], otp=code(owner)).json()["mode"] == "anonymized"
    assert len(calls) == 1 and len(calls[0]) == 25  # one request, not 25


# 17: bulk with mixed results ----------------------------------------------------------------------------------------
def test_bulk_mixed_results_do_not_block_each_other(world, owner, monkeypatch):
    occurrence(world.t2, in_hours=30)
    p1, p2 = make_user("m1@x.test", Role.PARENT), make_user("m2@x.test", Role.PARENT)
    from apps.accounts import erase

    real = erase._anonymize

    def boom(u, actor):
        if u.pk == world.s2.pk:
            raise RuntimeError("unexpected")
        return real(u, actor)

    monkeypatch.setattr(erase, "_anonymize", boom)
    Assignment.objects.create(student=world.s2, teacher=world.t2, kind="hifz", title="t", surah=1, ayah_from=1, ayah_to=7, due_at=timezone.now())
    r = delete(owner, [world.t2.pk, p1.pk, world.s2.pk, p2.pk], otp=code(owner)).json()
    assert r["success"] == 2 and r["failed"] == 2
    by = {e["id"]: e for e in r["errors"]}
    assert by[world.t2.pk]["code"] == "upcoming_sessions" and by[world.t2.pk]["label"] == world.t2.full_name
    assert by[world.s2.pk]["code"] == "unexpected" and by[world.s2.pk]["message"].startswith("تعذر إكمال الإجراء. رقم الطلب:")
    assert "unexpected" not in by[world.s2.pk]["message"].split(":")[0]
    assert not User.objects.filter(pk__in=[p1.pk, p2.pk]).exists()
    assert User.objects.get(pk=world.s2.pk).status == AccountStatus.ACTIVE  # its own transaction rolled back


# 20: no deleted personal data in the audit trail ------------------------------------------------------------------
def test_audit_holds_no_personal_data(world, owner):
    s = world.s1
    s.phone = "+201099998888"
    s.save()
    _, m = with_recording(s, world.t1)
    p = make_user("pii-parent@x.test", Role.PARENT, full_name="اسم ولي أمر خاص")
    delete(owner, [s.pk, p.pk], otp=code(owner))
    dump = json.dumps(list(AuditEvent.objects.filter(action__in=["admin.user_deleted", "admin.bulk_delete"]).values("data", "target_id")),
                      ensure_ascii=False)
    for secret in ("s1@x.test", "+201099998888", m.key, "pii-parent@x.test", "اسم ولي أمر خاص", s.full_name if s.full_name != "حساب محذوف" else "s1"):
        assert secret not in dump
    ev = AuditEvent.objects.filter(action="admin.user_deleted").order_by("id").first()
    assert set(ev.data) == {"role", "mode", "recordings_removed"} and ev.actor_id == owner.pk and ev.created_at
