"""Student excuses and the absence rule (owner decision 23 October 2026):
الطالب لا يلغي الجلسة — يطلب اعتذارًا، والمعلم يعتمد العذر. بعد 3 غيابات بدون عذر مقبول، يُوقف الحساب تلقائيًا."""
import threading
from datetime import timedelta

import pytest
from django.db import connection
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import AccountStatus, AuthToken, User
from apps.core.models import AppSettings, AuditEvent
from apps.notifications.models import Notification
from apps.scheduling import excuses, services
from apps.scheduling.models import Booking, BookingExcuse

from .conftest import PW, client_for, make_user, occurrence

pytestmark = pytest.mark.django_db
REASON = "ظرف عائلي طارئ"


def future_booking(w, student=None, teacher=None, hours=48, capacity=1, key=None):
    o = occurrence(teacher or w.t1, in_hours=hours, capacity=capacity)
    b, _ = services.book(student=student or w.s1, occurrence_id=o.pk, idempotency_key=key or f"k{o.pk}")
    return b


def past_booking(w, student=None, teacher=None, hours_ago=2):
    o = occurrence(teacher or w.t1, in_hours=-hours_ago)
    return Booking.objects.create(occurrence=o, student=student or w.s1, idempotency_key=f"p{o.pk}")


def excuse(student, b, reason=REASON):
    return client_for(student).post(f"/api/v1/bookings/{b.pk}/excuse", {"reason": reason}, format="json")


def decide(teacher, b, ok, response=""):
    return client_for(teacher).post(f"/api/v1/teacher/bookings/{b.pk}/excuse/{'approve' if ok else 'reject'}",
                                    {"response": response}, format="json")


def mark(teacher, b, value):
    return client_for(teacher).post(f"/api/v1/bookings/{b.pk}/attendance", {"attendance": value}, format="json")


def start(b):
    """The session time comes (bookings are made for the future; attendance is marked after the start)."""
    o = b.occurrence
    dur = o.ends_at - o.starts_at
    o.starts_at = timezone.now() - timedelta(minutes=5)
    o.ends_at = o.starts_at + dur
    o.save(update_fields=["starts_at", "ends_at"])


def kinds(u):
    return list(Notification.objects.filter(recipient=u).values_list("kind", flat=True))


# 1–3 ------------------------------------------------------------------------------------------
def test_student_cannot_cancel_and_sends_an_excuse_instead(world, django_capture_on_commit_callbacks):
    b = future_booking(world)
    r = client_for(world.s1).post(f"/api/v1/bookings/{b.pk}/cancel")
    assert r.status_code == 403 and r.json()["code"] == "excuse_instead"
    with django_capture_on_commit_callbacks(execute=True):
        r = excuse(world.s1, b)
    assert r.status_code == 201 and r.json()["status"] == "pending" and r.json()["reason"] == REASON
    b.refresh_from_db()
    assert b.status == "confirmed"  # an excuse never cancels the booking
    assert "excuse_new" in kinds(world.t1)
    assert REASON not in str(AuditEvent.objects.filter(action="booking.excuse_requested").values_list("data", flat=True))
    view = client_for(world.s1).get(f"/api/v1/bookings/{b.pk}").json()
    assert view["excuse"]["status"] == "pending" and view["can_excuse"] is False


def test_only_the_owner_can_send_and_input_is_checked(world):
    b = future_booking(world)
    assert excuse(world.s2, b).status_code == 404       # another student
    assert excuse(world.p1, b).status_code == 403       # parents cannot
    assert excuse(world.t1, b).status_code == 403
    assert excuse(world.s1, b, "قصير").json()["code"] == "invalid"   # 4 chars
    assert excuse(world.s1, b, "x" * 501).json()["code"] == "invalid"
    assert not BookingExcuse.objects.exists()


def test_deadline_is_configurable(world):
    b = future_booking(world, hours=2)
    cfg = AppSettings.load()
    cfg.excuse_deadline_minutes = 180
    cfg.save()
    r = excuse(world.s1, b)
    assert r.status_code == 409 and r.json()["code"] == "excuse_deadline" and "بدون عذر" in r.json()["message"]
    cfg.excuse_deadline_minutes = 60
    cfg.save()
    assert excuse(world.s1, b).status_code == 201
    assert client_for(world.admin).patch("/api/v1/admin/settings", {"excuse_deadline_minutes": 30}, format="json").status_code == 200
    assert AppSettings.load().excuse_deadline_minutes == 30


# 4–8 ------------------------------------------------------------------------------------------
def test_teacher_reviews_own_sessions_only_and_approval_records_excused(world, django_capture_on_commit_callbacks):
    b = future_booking(world)
    excuse(world.s1, b)
    pending = client_for(world.t1).get("/api/v1/teacher/excuses").json()["results"]
    assert [x["booking"] for x in pending] == [b.pk] and pending[0]["reason"] == REASON
    assert client_for(world.t2).get("/api/v1/teacher/excuses").json()["results"] == []
    assert decide(world.t2, b, True).status_code == 404                        # other teacher
    assert client_for(world.s1).post(f"/api/v1/teacher/bookings/{b.pk}/excuse/approve").status_code == 403
    assert client_for(world.p1).post(f"/api/v1/teacher/bookings/{b.pk}/excuse/approve").status_code == 403
    with django_capture_on_commit_callbacks(execute=True):
        r = decide(world.t1, b, True)
    assert r.status_code == 200 and r.json()["status"] == "approved"
    b.refresh_from_db()
    assert b.attendance == "excused" and b.status == "confirmed"
    assert "excuse_approved" in kinds(world.s1) and "excuse_child" in kinds(world.p1)
    assert AuditEvent.objects.filter(action="booking.excuse_approved").exists()
    # Even if the teacher later marks «غائب», the approved excuse keeps it «غاب بعذر» and it never counts.
    start(b)
    assert mark(world.t1, b, "absent").json()["attendance"] == "excused"
    assert excuses.unexcused_count(world.s1) == 0
    assert decide(world.t1, b, False, "سبب").json()["code"] == "already_reviewed"


# 9–10, 17 ---------------------------------------------------------------------------------------
def test_rejected_or_pending_excuse_and_absence(world, django_capture_on_commit_callbacks):
    b = future_booking(world)
    excuse(world.s1, b)
    start(b)
    mark(world.t1, b, "absent")
    assert excuses.unexcused_count(world.s1) == 0       # pending: not counted yet
    assert decide(world.t1, b, False).json()["code"] == "invalid"   # a reason is required to reject
    with django_capture_on_commit_callbacks(execute=True):
        r = decide(world.t1, b, False, "لم يُرسل في وقت مناسب")
    assert r.json()["status"] == "rejected"
    assert excuses.unexcused_count(world.s1) == 1
    n = Notification.objects.get(recipient=world.s1, kind="excuse_rejected")
    assert "لم يتم قبول الاعتذار" in n.title and "لم يُرسل في وقت مناسب" in n.body
    assert "absence_warning" in kinds(world.s1)
    parent = client_for(world.p1).get(f"/api/v1/bookings/{b.pk}").json()["excuse"]
    assert parent["status"] == "rejected" and "reason" not in parent and "teacher_response" not in parent


# 11–15 ------------------------------------------------------------------------------------------
def test_warnings_then_suspension_on_the_third_unexcused_absence(world, django_capture_on_commit_callbacks):
    s = world.s1
    native = client_for(s)
    web = APIClient()
    assert web.post("/api/v1/auth/login", {"email": s.email, "password": PW}, format="json").status_code == 200
    bs = [past_booking(world, hours_ago=h) for h in (72, 48, 24)]
    with django_capture_on_commit_callbacks(execute=True):
        mark(world.t1, bs[0], "absent")
    s.refresh_from_db()
    assert s.status == "active" and Notification.objects.get(recipient=s, kind="absence_warning").title == "تم تسجيل غياب بدون عذر."
    with django_capture_on_commit_callbacks(execute=True):
        mark(world.t1, bs[1], "absent")
    s.refresh_from_db()
    assert s.status == "active"
    assert Notification.objects.filter(recipient=s, kind="absence_warning", title="تنبيه أخير بسبب الغياب").exists()
    with django_capture_on_commit_callbacks(execute=True):
        mark(world.t1, bs[2], "absent")
    s.refresh_from_db()
    assert s.status == "suspended" and s.status_reason == excuses.AUTO_REASON
    ev = AuditEvent.objects.get(action="student.auto_suspended_absence")
    assert ev.data == {"student": s.pk, "unexcused": 3, "booking": bs[2].pk}
    assert not AuthToken.objects.filter(user=s, revoked_at__isnull=True).exists()
    assert native.get("/api/v1/me").status_code == 401 and web.get("/api/v1/me").status_code in (401, 403)
    assert APIClient().post("/api/v1/auth/login", {"email": s.email, "password": PW}, format="json").json()["code"] == "account_suspended"
    with pytest.raises(Exception):
        services.book(student=s, occurrence_id=occurrence(world.t2).pk, idempotency_key="after")
    assert "account_suspended" in kinds(s) and "account_suspended_child" in kinds(world.p1)
    assert "admin_absence_suspension" in kinds(world.admin)
    # Marking it again (or another call) never suspends twice.
    mark(world.t1, bs[2], "absent")
    assert AuditEvent.objects.filter(action="student.auto_suspended_absence").count() == 1
    d = client_for(world.admin).get(f"/api/v1/admin/users/{s.pk}/discipline").json()
    assert d["unexcused_absences"] == 3 and d["suspended"] and d["status_reason"] == excuses.AUTO_REASON
    assert sum(a["counts"] for a in d["absences"]) == 3


# 20–21 ------------------------------------------------------------------------------------------
def test_admin_override_is_audited_and_reactivation_keeps_history(world, django_capture_on_commit_callbacks):
    s = world.s1
    bs = [past_booking(world, hours_ago=h) for h in (72, 48, 24)]
    approved = future_booking(world, hours=96)
    excuse(s, approved)
    decide(world.t1, approved, True)
    rejected = future_booking(world, hours=120)
    excuse(s, rejected)
    decide(world.t1, rejected, False, "غير مقبول")
    for b in bs:
        mark(world.t1, b, "absent")
    s.refresh_from_db()
    assert s.status == "suspended"
    c = client_for(world.admin)
    assert c.post(f"/api/v1/admin/bookings/{bs[2].pk}/excuse-override", {}, format="json").status_code == 400  # reason
    with django_capture_on_commit_callbacks(execute=True):
        r = c.post(f"/api/v1/admin/bookings/{bs[2].pk}/excuse-override", {"reason": "شهادة طبية"}, format="json")
    assert r.status_code == 200 and r.json()["status"] == "approved" and r.json()["overridden"]
    ev = AuditEvent.objects.get(action="booking.excuse_admin_override")
    assert ev.data["previous"] == "none" and ev.data["reason"] == "شهادة طبية"
    assert excuses.unexcused_count(s) == 2
    s.refresh_from_db()
    assert s.status == "suspended"  # pilot policy: no automatic reactivation; admins are alerted
    assert AuditEvent.objects.filter(action="student.absence_suspension_review").exists()
    assert "admin_absence_review" in kinds(world.admin)
    # Override of a rejected excuse keeps the teacher's decision traceable.
    c.post(f"/api/v1/admin/bookings/{rejected.pk}/excuse-override", {"reason": "مراجعة إدارية"}, format="json")
    ex = BookingExcuse.objects.get(booking=rejected)
    assert ex.status == "approved" and ex.teacher_status == "rejected" and ex.teacher_response == "غير مقبول"
    # Reactivation needs a reason and never erases the history.
    assert c.post(f"/api/v1/admin/users/{s.pk}/status", {"status": "active"}, format="json").status_code == 400
    assert c.post(f"/api/v1/admin/users/{s.pk}/status", {"status": "active", "reason": "تمت مراجعة حالة الطالب"}, format="json").status_code == 200
    assert BookingExcuse.objects.filter(student=s, status="approved").count() == 3
    assert excuses.unexcused_count(s) == 2
    # Back to 2 after reactivation; the next unexcused absence suspends again.
    mark(world.t1, past_booking(world, hours_ago=6), "absent")
    s.refresh_from_db()
    assert s.status == "suspended"


def test_correction_to_present_lowers_the_count(world):
    bs = [past_booking(world, hours_ago=h) for h in (72, 48, 24)]
    for b in bs:
        mark(world.t1, b, "absent")
    world.s1.refresh_from_db()
    assert world.s1.status == "suspended"
    mark(world.t1, bs[2], "present")
    world.s1.refresh_from_db()
    assert excuses.unexcused_count(world.s1) == 2 and world.s1.status == "suspended"
    assert AuditEvent.objects.filter(action="student.absence_suspension_review").exists()


# 18–19, 22 ---------------------------------------------------------------------------------------
def test_duplicate_requests_are_safe(world):
    b = future_booking(world)
    assert excuse(world.s1, b).status_code == 201
    assert excuse(world.s1, b).status_code == 200                       # the same request again
    assert excuse(world.s1, b, "سبب مختلف تمامًا").json()["code"] == "excuse_exists"
    assert BookingExcuse.objects.count() == 1


@pytest.mark.django_db(transaction=True)
def test_concurrent_approve_and_reject_only_one_wins(world):
    b = future_booking(world)
    excuses.request_excuse(booking_id=b.pk, student=world.s1, reason=REASON)
    results = []

    def run(ok):
        try:
            excuses.review(booking_id=b.pk, actor=world.t1, approve=ok, response="" if ok else "سبب الرفض")
            results.append("ok")
        except Exception as e:  # noqa: BLE001
            results.append(getattr(e, "code", type(e).__name__))
        finally:
            connection.close()

    ts = [threading.Thread(target=run, args=(ok,)) for ok in (True, False)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert sorted(results) == ["already_reviewed", "ok"]
    ex = BookingExcuse.objects.get(booking=b)
    assert ex.status in ("approved", "rejected") and ex.status == ex.teacher_status


def test_group_session_excuse_affects_only_that_student(world):
    o = occurrence(world.t1, in_hours=48, capacity=5)
    b1, _ = services.book(student=world.s1, occurrence_id=o.pk, idempotency_key="g1")
    s3 = make_user("s3@x.test")
    b2, _ = services.book(student=s3, occurrence_id=o.pk, idempotency_key="g2")
    excuse(world.s1, b1)
    decide(world.t1, b1, True)
    b1.refresh_from_db()
    b2.refresh_from_db()
    assert b1.attendance == "excused" and b2.attendance == "" and not BookingExcuse.objects.filter(booking=b2).exists()
    sessions = client_for(world.t1).get("/api/v1/teacher/occurrences").json()
    occ = next(x for x in sessions if x["id"] == o.pk)
    by = {x["id"]: x for x in occ["bookings"]}
    assert by[b1.pk]["excuse"]["status"] == "approved" and by[b2.pk]["excuse"] is None


def test_people_filter_and_admin_excuse_list(world):
    for h in (72, 48):
        mark(world.t1, past_booking(world, hours_ago=h), "absent")
    b = future_booking(world, student=world.s2, teacher=world.t2)
    excuse(world.s2, b)
    c = client_for(world.admin)
    near = c.get("/api/v1/admin/users", {"role": "student", "unexcused": "2", "status": "active"}).json()["results"]
    assert [u["id"] for u in near] == [world.s1.pk]
    assert c.get("/api/v1/admin/users", {"role": "student", "unexcused": "3"}).json()["results"] == []
    pend = c.get("/api/v1/admin/excuses").json()["results"]
    assert [x["booking"] for x in pend] == [b.pk]
    assert client_for(world.t1).get("/api/v1/admin/excuses").status_code == 403
    assert User.objects.get(pk=world.s1.pk).status == AccountStatus.ACTIVE


# ---- admin decisions on pending requests («طلبات الاعتذار» in the portal) ------------------------------------
def admin_decide(u, b, approve, response=""):
    return client_for(u).post(f"/api/v1/admin/bookings/{b.pk}/excuse/review", {"approve": approve, "response": response}, format="json")


def test_admin_approves_pending_excuse(world, django_capture_on_commit_callbacks):
    b = future_booking(world)
    excuse(world.s1, b)
    with django_capture_on_commit_callbacks(execute=True):
        r = admin_decide(world.admin, b, True)
    assert r.status_code == 200 and r.json()["status"] == "approved" and r.json()["decided_by"] == "admin"
    b.refresh_from_db()
    assert b.attendance == "excused"
    ex = BookingExcuse.objects.get(booking=b)
    assert ex.reviewed_by == world.admin and ex.teacher_status == "" and ex.decided_by_role == "admin"
    ev = AuditEvent.objects.get(action="booking.excuse_admin_approved")
    assert ev.data["decision"] == "approved" and ev.data["has_response"] is False and REASON not in str(ev.data)
    assert not AuditEvent.objects.filter(action="booking.excuse_approved").exists()
    assert "excuse_approved" in kinds(world.s1) and "excuse_child" in kinds(world.p1) and "excuse_decided" in kinds(world.t1)
    # the teacher sees the final state; nothing is left pending for them
    assert client_for(world.t1).get("/api/v1/teacher/excuses").json()["results"] == []
    occ = next(x for x in client_for(world.t1).get("/api/v1/teacher/occurrences").json() if x["id"] == b.occurrence_id)
    assert occ["bookings"][0]["excuse"]["status"] == "approved"
    start(b)
    assert mark(world.t1, b, "absent").json()["attendance"] == "excused" and excuses.unexcused_count(world.s1) == 0


def test_admin_reject_requires_reason_and_does_not_mark_absent(world, django_capture_on_commit_callbacks):
    b = future_booking(world)
    excuse(world.s1, b)
    r = admin_decide(world.admin, b, False, "ن")
    assert r.status_code == 400 and r.json()["code"] == "invalid"
    assert admin_decide(world.admin, b, "yes").status_code == 400  # approve must be a boolean
    with django_capture_on_commit_callbacks(execute=True):
        r = admin_decide(world.admin, b, False, "الموعد قريب جدًا")
    assert r.status_code == 200 and r.json()["status"] == "rejected" and r.json()["admin_response"] == "الموعد قريب جدًا"
    b.refresh_from_db()
    assert b.attendance == "" and excuses.unexcused_count(world.s1) == 0   # not marked absent automatically
    n = Notification.objects.get(recipient=world.s1, kind="excuse_rejected")
    assert "رد الإدارة: الموعد قريب جدًا" in n.body
    pn = Notification.objects.get(recipient=world.p1, kind="excuse_child")
    assert "الموعد قريب جدًا" not in pn.title + pn.body   # the parent gets the outcome only
    ev = AuditEvent.objects.get(action="booking.excuse_admin_rejected")
    assert ev.data["has_response"] is True and "الموعد" not in str(ev.data)
    # a later «غاب» now counts as unexcused
    start(b)
    assert mark(world.t1, b, "absent").json()["attendance"] == "absent"
    assert excuses.unexcused_count(world.s1) == 1


def test_admin_review_needs_permission(world):
    from .test_admins import staff
    b = future_booking(world)
    excuse(world.s1, b)
    support = staff("sup@x.test", preset="content")
    assert admin_decide(support, b, True).status_code == 403
    assert admin_decide(world.t1, b, True).status_code == 403
    assert admin_decide(world.s1, b, True).status_code == 403
    assert admin_decide(world.p1, b, True).status_code == 403
    assert BookingExcuse.objects.get(booking=b).status == "pending"
    assert admin_decide(staff("acad@x.test", preset="academic_manager"), b, True).status_code == 200


def test_already_decided_and_badge_count(world):
    b1, b2 = future_booking(world), future_booking(world, hours=72)
    excuse(world.s1, b1)
    excuse(world.s1, b2)
    c = client_for(world.admin)
    assert len(c.get("/api/v1/admin/excuses").json()["results"]) == 2
    assert decide(world.t1, b1, True).status_code == 200            # the teacher decided first
    r = admin_decide(world.admin, b1, False, "سبب الرفض")
    assert r.status_code == 409 and r.json()["message"] == "تمت مراجعة هذا الاعتذار بالفعل."
    assert admin_decide(world.admin, b2, True).status_code == 200
    assert decide(world.t1, b2, False, "سبب").json()["code"] == "already_reviewed"
    assert c.get("/api/v1/admin/excuses").json()["results"] == []   # the badge counts pending rows
    done = {x["booking"]: x["decided_by"] for x in c.get("/api/v1/admin/excuses", {"status": "approved"}).json()["results"]}
    assert done == {b1.pk: "teacher", b2.pk: "admin"}
    assert BookingExcuse.objects.get(booking=b1).status == "approved"


@pytest.mark.django_db(transaction=True)
def test_teacher_and_admin_race_only_one_wins(world):
    b = future_booking(world)
    excuses.request_excuse(booking_id=b.pk, student=world.s1, reason=REASON)
    results = []

    def run(kw):
        try:
            excuses.review(booking_id=b.pk, **kw)
            results.append("ok")
        except Exception as e:  # noqa: BLE001
            results.append(getattr(e, "code", type(e).__name__))
        finally:
            connection.close()

    ts = [threading.Thread(target=run, args=(kw,)) for kw in (
        {"actor": world.t1, "approve": True}, {"actor": world.admin, "approve": False, "response": "سبب الرفض", "as_admin": True})]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert sorted(results) == ["already_reviewed", "ok"]
    assert BookingExcuse.objects.get(booking=b).status in ("approved", "rejected")
