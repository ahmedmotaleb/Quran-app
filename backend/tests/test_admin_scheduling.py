"""Admin portal: circles, their sessions and booking oversight (pack prompt 06)."""
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.notifications.models import Notification
from apps.scheduling.models import Booking, Circle, SessionOccurrence

from .conftest import client_for, make_user, occurrence

pytestmark = pytest.mark.django_db
A = "/api/v1/admin"


def _book(student, occ_id, key="k1"):
    return client_for(student).post("/api/v1/bookings", {"occurrence": occ_id}, format="json", HTTP_IDEMPOTENCY_KEY=key)


def _circle(c, t, **kw):
    r = c.post(f"{A}/circles", {"name": "حلقة الفجر", "teacher": t.id, "capacity": 3, "level": "مبتدئ", **kw}, format="json")
    assert r.status_code == 201, r.json()
    return r.json()


def test_admin_scheduling_endpoints_refuse_other_roles(world):
    for who in (world.s1, world.t1, world.p1):
        c = client_for(who)
        for m, url in [("get", f"{A}/circles"), ("post", f"{A}/circles"), ("get", f"{A}/bookings"), ("get", f"{A}/bookings/counts"),
                       ("post", f"{A}/bookings/1/cancel"), ("post", f"{A}/sessions/1/cancel"), ("post", f"{A}/circles/1/sessions")]:
            assert getattr(c, m)(url, {}, format="json").status_code == 403, (who.email, url)


def test_circle_lifecycle_sessions_visibility_and_booking(world):
    c = client_for(world.admin)
    circ = _circle(c, world.t1)
    assert circ["state"] == "draft"
    nxt = timezone.localdate() + timedelta(days=3)
    body = {"weekday": nxt.weekday(), "time": "18:00", "minutes": 60, "weeks": 2, "timezone": "Africa/Cairo"}
    prev = c.post(f"{A}/circles/{circ['id']}/sessions", {**body, "dry_run": True}, format="json").json()
    assert prev["dry_run"] and prev["created"] == 0 and len(prev["plan"]) == 2 and all(x["ok"] for x in prev["plan"])
    assert not SessionOccurrence.objects.filter(circle_id=circ["id"]).exists()
    r = c.post(f"{A}/circles/{circ['id']}/sessions", body, format="json")
    assert r.status_code == 201 and r.json()["created"] == 2
    occ = SessionOccurrence.objects.filter(circle_id=circ["id"]).order_by("starts_at").first()
    assert occ.kind == "group" and occ.capacity == 3
    from zoneinfo import ZoneInfo
    assert occ.starts_at.astimezone(ZoneInfo("Africa/Cairo")).strftime("%H:%M") == "18:00"  # local time kept across DST
    # Draft circle: hidden from students and not bookable.
    slots = lambda: [s["id"] for s in client_for(world.s1).get(f"/api/v1/teachers/{world.t1.id}/slots").json()]  # noqa: E731
    assert occ.id not in slots()
    assert _book(world.s1, occ.id).json()["code"] == "slot_unavailable"
    # Published: visible with its name, bookable up to capacity.
    assert c.post(f"{A}/circles/{circ['id']}/state", {"state": "published"}, format="json").json()["state"] == "published"
    assert occ.id in slots()
    assert _book(world.s1, occ.id).status_code == 201
    assert _book(world.s2, occ.id).status_code == 201
    detail = c.get(f"{A}/circles/{circ['id']}").json()
    assert detail["sessions"][0]["booked"] == 2 and detail["upcoming_booked_seats"] == 2
    # Capacity cannot go below seats taken.
    assert c.patch(f"{A}/circles/{circ['id']}", {"capacity": 1}, format="json").status_code == 400
    assert c.patch(f"{A}/circles/{circ['id']}", {"capacity": 5}, format="json").json()["capacity"] == 5
    occ.refresh_from_db()
    assert occ.capacity == 5
    # Off needs a reason; hidden again, existing bookings kept.
    assert c.post(f"{A}/circles/{circ['id']}/state", {"state": "off"}, format="json").status_code == 400
    assert c.post(f"{A}/circles/{circ['id']}/state", {"state": "off", "reason": "إجازة المعلم"}, format="json").status_code == 200
    assert occ.id not in slots()
    assert Booking.objects.filter(occurrence=occ, status="confirmed").count() == 2


def test_sessions_conflict_with_booked_time_but_replace_open_slots(world):
    c = client_for(world.admin)
    circ = _circle(c, world.t1)
    open_slot = occurrence(world.t1, in_hours=72)
    booked = occurrence(world.t1, in_hours=96)
    assert _book(world.s1, booked.id).status_code == 201
    from zoneinfo import ZoneInfo
    tz = ZoneInfo("Africa/Cairo")
    for o, expect_ok in ((open_slot, True), (booked, False)):
        local = o.starts_at.astimezone(tz)
        r = c.post(f"{A}/circles/{circ['id']}/sessions", {"weekday": local.weekday(), "time": local.strftime("%H:%M"), "minutes": 45,
                                                          "weeks": 1, "start": local.date().isoformat(), "timezone": "Africa/Cairo"}, format="json").json()
        assert r["plan"][0]["ok"] is expect_ok, r
    open_slot.refresh_from_db()
    assert open_slot.status == "cancelled"  # unbooked open slot replaced by the circle session
    booked.refresh_from_db()
    assert booked.status == "scheduled"


def test_publish_requires_approved_teacher(world):
    c = client_for(world.admin)
    circ = _circle(c, world.t2)
    world.t2.teacher_profile.approved_at = None
    world.t2.teacher_profile.save()
    assert c.post(f"{A}/circles/{circ['id']}/state", {"state": "published"}, format="json").json()["code"] == "teacher_not_approved"


def test_unapproved_teacher_cannot_be_booked(world):
    o = occurrence(world.t1, in_hours=48)
    world.t1.teacher_profile.approved_at = None
    world.t1.teacher_profile.save()
    assert o.id not in [s["id"] for s in client_for(world.s1).get(f"/api/v1/teachers/{world.t1.id}/slots").json()]
    assert _book(world.s1, o.id).json()["code"] == "slot_unavailable"


def test_admin_cancels_booking_with_reason_and_student_is_notified(world, django_capture_on_commit_callbacks):
    o = occurrence(world.t1, in_hours=5)  # inside the student's own cancel window: admin may still cancel
    bid = _book(world.s1, o.id).json()["id"]
    c = client_for(world.admin)
    lst = c.get(f"{A}/bookings", {"q": "s1"}).json()
    assert lst["count"] == 1 and lst["results"][0]["id"] == bid
    assert c.post(f"{A}/bookings/{bid}/cancel", {}, format="json").status_code == 400
    with django_capture_on_commit_callbacks(execute=True):
        r = c.post(f"{A}/bookings/{bid}/cancel", {"reason": "تعارض في الجدول"}, format="json").json()
    assert r["status"] == "cancelled" and r["cancel_reason"] == "تعارض في الجدول" and r["cancelled_by"]
    assert Notification.objects.filter(recipient=world.s1, kind="booking_cancelled").exists()
    assert Booking.objects.filter(pk=bid).exists()  # history kept
    assert c.get(f"{A}/bookings", {"status": "cancelled"}).json()["count"] == 1
    # The seat is free again for someone else.
    assert _book(world.s2, o.id).status_code == 201


def test_admin_cancels_whole_session(world, django_capture_on_commit_callbacks):
    o = occurrence(world.t1, in_hours=30, capacity=3, kind="group")
    for s, k in ((world.s1, "a"), (world.s2, "b")):
        assert _book(s, o.id, k).status_code == 201
    c = client_for(world.admin)
    with django_capture_on_commit_callbacks(execute=True):
        r = c.post(f"{A}/sessions/{o.id}/cancel", {"reason": "عذر طارئ"}, format="json").json()
    assert r["bookings_cancelled"] == 2
    assert Booking.objects.filter(occurrence=o, status="cancelled", cancel_reason="عذر طارئ").count() == 2
    assert Notification.objects.filter(kind="booking_cancelled").count() == 2
    assert c.post(f"{A}/sessions/{o.id}/cancel", {"reason": "عذر طارئ"}, format="json").json()["bookings_cancelled"] == 0


def test_circle_teacher_change_blocked_with_upcoming_sessions(world):
    c = client_for(world.admin)
    circ = _circle(c, world.t1)
    nxt = timezone.localdate() + timedelta(days=2)
    c.post(f"{A}/circles/{circ['id']}/sessions", {"weekday": nxt.weekday(), "time": "07:00", "minutes": 30, "weeks": 1}, format="json")
    assert c.patch(f"{A}/circles/{circ['id']}", {"teacher": world.t2.id}, format="json").json()["code"] == "has_sessions"
    assert Circle.objects.get(pk=circ["id"]).teacher_id == world.t1.id
    t3 = make_user("t3@x.test", role="teacher")
    other = _circle(c, t3, name="حلقة أخرى")
    assert c.patch(f"{A}/circles/{other['id']}", {"teacher": world.t2.id}, format="json").status_code == 200
