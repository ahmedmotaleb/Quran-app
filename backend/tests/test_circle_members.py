"""Circle membership with automatic booking (owner decision 20 October 2026)."""
from datetime import timedelta

import pytest
from django.core.management import call_command
from django.utils import timezone

from apps.core.models import AuditEvent
from apps.notifications.models import Notification
from apps.scheduling.models import Booking, Circle, CircleMember, SessionOccurrence

from .conftest import client_for, make_user, occurrence

pytestmark = pytest.mark.django_db
A = "/api/v1/admin"


def circle(teacher, capacity=3, state=Circle.State.PUBLISHED, name="حلقة الفجر"):
    return Circle.objects.create(name=name, teacher=teacher, capacity=capacity, state=state)


def session(c, in_hours):
    return occurrence(c.teacher, in_hours=in_hours, kind="group", circle=c, capacity=c.capacity)


def confirmed(student, c):
    return Booking.objects.filter(student=student, occurrence__circle=c, status="confirmed").count()


def test_join_books_every_upcoming_session_once_and_notifies(world, django_capture_on_commit_callbacks):
    c = circle(world.t1)
    past = session(c, -30)
    for h in (24, 48, 72):
        session(c, h)
    admin = client_for(world.admin)
    with django_capture_on_commit_callbacks(execute=True):
        r = admin.post(f"{A}/circles/{c.id}/members", {"student": world.s1.id}, format="json")
    assert r.status_code == 201 and r.json()["booked"] == 3
    assert confirmed(world.s1, c) == 3 and not past.bookings.exists()
    assert Notification.objects.filter(recipient=world.s1, kind="circle_joined").count() == 1  # one, not three
    assert Notification.objects.filter(recipient=world.s1, kind="booking_confirmed").count() == 0
    assert AuditEvent.objects.filter(action="admin.circle_member_added").exists()
    again = admin.post(f"{A}/circles/{c.id}/members", {"student": world.s1.id}, format="json")
    assert again.status_code == 409 and again.json()["code"] == "already_member"
    call_command("sync_circle_members")
    assert confirmed(world.s1, c) == 3  # idempotent


def test_capacity_published_state_and_conflicts(world):
    admin = client_for(world.admin)
    draft = circle(world.t1, state=Circle.State.DRAFT, name="مسودة")
    assert admin.post(f"{A}/circles/{draft.id}/members", {"student": world.s1.id}, format="json").json()["code"] == "not_published"
    c = circle(world.t2, capacity=2)
    s3 = make_user("s3@x.test")
    for s in (world.s1, world.s2):
        assert admin.post(f"{A}/circles/{c.id}/members", {"student": s.id}, format="json").status_code == 201
    assert admin.post(f"{A}/circles/{c.id}/members", {"student": s3.id}, format="json").json()["code"] == "circle_full"
    big = circle(world.t1, capacity=3, name="كبيرة")
    for s in (world.s1, world.s2, s3):
        admin.post(f"{A}/circles/{big.id}/members", {"student": s.id}, format="json")
    r = admin.patch(f"{A}/circles/{big.id}", {"capacity": 2}, format="json")
    assert r.status_code == 400 and "الأعضاء" in r.json()["fields"]["capacity"][0]
    # A session the student cannot attend (another booking at the same time) is skipped, not double-booked.
    other = occurrence(world.t1, in_hours=30)
    Booking.objects.create(occurrence=other, student=world.s1, idempotency_key="own")
    o = SessionOccurrence.objects.create(teacher=world.t2, kind="group", circle=c, starts_at=other.starts_at, ends_at=other.ends_at, capacity=2)
    call_command("sync_circle_members")
    assert not o.bookings.filter(student=world.s1).exists() and o.bookings.filter(student=world.s2).exists()


def test_new_sessions_book_members_and_leaving_cancels_future_only(world, django_capture_on_commit_callbacks):
    admin = client_for(world.admin)
    c = circle(world.t1)
    past = session(c, -30)
    m_id = admin.post(f"{A}/circles/{c.id}/members", {"student": world.s1.id}, format="json").json()["id"]
    Booking.objects.create(occurrence=past, student=world.s1, idempotency_key="past", attendance="present")
    start = (timezone.localdate() + timedelta(days=2)).isoformat()
    r = admin.post(f"{A}/circles/{c.id}/sessions", {"weekday": (timezone.localdate() + timedelta(days=2)).weekday(), "time": "17:00",
                                                   "minutes": 60, "weeks": 2, "start": start, "timezone": "Africa/Cairo"}, format="json")
    assert r.status_code == 201 and r.json()["members_booked"] == 2
    with django_capture_on_commit_callbacks(execute=True):
        r = admin.post(f"{A}/circle-members/{m_id}/end", {"reason": "انتقل لحلقة أخرى"}, format="json")
    assert r.json()["bookings_cancelled"] == 2
    assert confirmed(world.s1, c) == 1  # the past session keeps its booking and attendance
    assert Booking.objects.get(occurrence=past, student=world.s1).attendance == "present"
    assert Notification.objects.filter(recipient=world.s1, kind="circle_left").exists()
    assert admin.get(f"{A}/circles/{c.id}/members").json()["active"] == 0
    assert admin.get(f"{A}/circles/{c.id}/members?all=1").json()["results"][0]["end_reason"] == "انتقل لحلقة أخرى"
    # Rejoining re-confirms the cancelled future bookings.
    assert admin.post(f"{A}/circles/{c.id}/members", {"student": world.s1.id}, format="json").json()["booked"] == 2


def test_bulk_move_to_circle(world):
    admin = client_for(world.admin)
    old, new = circle(world.t1, name="القديمة"), circle(world.t2, capacity=2, name="الجديدة")
    session(old, 24)
    session(new, 50)
    admin.post(f"{A}/circles/{old.id}/members", {"student": world.s1.id}, format="json")
    r = admin.post(f"{A}/users/bulk-action", {"action": "move_to_circle", "ids": [world.s1.id, world.s2.id, world.p1.id],
                                             "params": {"circle": new.id}}, format="json").json()
    assert (r["success"], r["failed"]) == (2, 1)
    assert set(CircleMember.objects.filter(active=True).values_list("circle_id", "student_id")) == {(new.id, world.s1.id), (new.id, world.s2.id)}
    assert confirmed(world.s1, old) == 0 and confirmed(world.s1, new) == 1
    s3 = make_user("s3@x.test")
    full = admin.post(f"{A}/users/bulk-action", {"action": "move_to_circle", "ids": [s3.id], "params": {"circle": new.id}}, format="json").json()
    assert full["failed"] == 1 and full["results"][0]["code"] == "circle_full"
    off = circle(world.t1, state=Circle.State.OFF, name="موقوفة")
    assert admin.post(f"{A}/users/bulk-action", {"action": "move_to_circle", "ids": [s3.id], "params": {"circle": off.id}},
                      format="json").status_code == 400
    assert admin.get(f"{A}/users", {"role": "student", "circle": new.id}).json()["count"] == 2


def test_members_endpoints_are_admin_only(world):
    c = circle(world.t1)
    for who in (world.s1, world.t1, world.p1):
        assert client_for(who).get(f"{A}/circles/{c.id}/members").status_code == 403
        assert client_for(who).post(f"{A}/circles/{c.id}/members", {"student": world.s1.id}, format="json").status_code == 403
