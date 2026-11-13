"""«إنشاء جلسة» from the teacher's appointments (owner report 13 Nov 2026, P0: the teacher could not create a session).

Root cause: creation required a connected Google Calendar (the server refused before saving anything; the app
disabled the button), and when Google failed the session stayed hidden «قيد التجهيز» with nobody booked or told.
Now the session is saved in PostgreSQL on its own — scheduled, booked, notified, in the teacher's schedule — and
Google Calendar/Meet is an optional step after the commit that can fail without undoing anything.
"""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from django.utils import timezone

from apps.integrations import sync
from apps.integrations.models import GoogleEvent
from apps.notifications.models import Notification
from apps.scheduling.models import Booking, Circle, CircleMember, SessionOccurrence

from .conftest import client_for, make_user
from .test_google_calendar import connect, g  # noqa: F401  (fixture)

pytestmark = pytest.mark.django_db
URL = "/api/v1/teacher/sessions"
CAIRO = ZoneInfo("Africa/Cairo")


@pytest.fixture(autouse=True)
def no_google(settings):
    """Google Calendar is NOT configured on this server (the owner's case)."""
    settings.GOOGLE_CLIENT_ID = settings.GOOGLE_CLIENT_SECRET = ""
    settings.GOOGLE_FAKE = False


def day(n=2, tz=CAIRO):
    return (timezone.now().astimezone(tz) + timedelta(days=n)).date().isoformat()


def create(teacher, key="tsess-0001", capture=None, **kw):
    body = {"student": kw.pop("student", None), "circle": kw.pop("circle", None), "topic": kw.pop("topic", "hifz"),
            "date": kw.pop("date", day()), "time": kw.pop("time", "19:00"), "minutes": kw.pop("minutes", 45), **kw}
    c = client_for(teacher)
    if capture is None:
        return c.post(URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key)
    with capture(execute=True):
        return c.post(URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key)


@pytest.mark.parametrize("topic,label", [("hifz", "حفظ"), ("review", "مراجعة"), ("tajweed", "تجويد"), ("test", "اختبار"), ("other", "أخرى")])
def test_every_session_type_is_created_without_google(world, topic, label, django_capture_on_commit_callbacks):
    r = create(world.t1, key=f"type-{topic}-01", capture=django_capture_on_commit_callbacks, student=world.s1.pk, topic=topic,
               title="سورة الملك", prep_note="راجع الآيات 1–5")
    assert r.status_code == 201, r.json()
    body = r.json()
    occ = SessionOccurrence.objects.get(pk=body["id"])                               # saved in PostgreSQL, id returned
    assert occ.teacher == world.t1 and occ.status == "scheduled" and occ.topic == topic and occ.title == "سورة الملك"
    assert body["topic_label"] == label and body["google"] is None and body["with"] == {"kind": "student", "id": world.s1.pk, "name": world.s1.full_name}
    assert Booking.objects.filter(occurrence=occ, student=world.s1, status="confirmed").count() == 1
    n = Notification.objects.get(recipient=world.s1, kind="booking_created")
    assert n.title == f"تم حجز جلسة {label}" and ("مساءً" in n.body)                # 19:00 → «٧:٠٠ مساءً»
    assert not GoogleEvent.objects.exists()


def test_session_appears_in_the_teacher_schedule_and_for_the_student(world, django_capture_on_commit_callbacks):
    sid = create(world.t1, capture=django_capture_on_commit_callbacks, student=world.s1.pk).json()["id"]
    sched = client_for(world.t1).get("/api/v1/teacher/occurrences?days=8").json()
    rows = sched if isinstance(sched, list) else sched["results"]
    assert sid in [o["id"] for o in rows]
    mine = client_for(world.s1).get("/api/v1/bookings").json()
    mine = mine if isinstance(mine, list) else mine["results"]
    assert any((b.get("occurrence") or {}).get("id") == sid if isinstance(b.get("occurrence"), dict) else b.get("occurrence") == sid for b in mine)
    other = client_for(world.s2).get("/api/v1/bookings").json()
    other = other if isinstance(other, list) else other["results"]
    assert not other                                                                   # unrelated student sees nothing


def test_time_is_the_teachers_local_wall_clock(world):
    # Cairo (UTC+2 in winter, from the IANA database): 19:00 local is 17:00 UTC.
    d = day(3)
    sid = create(world.t1, key="tz-cairo-01", student=world.s1.pk, date=d, time="19:00").json()["id"]
    occ = SessionOccurrence.objects.get(pk=sid)
    assert occ.starts_at.astimezone(CAIRO).strftime("%H:%M") == "19:00"
    assert occ.starts_at == datetime.fromisoformat(f"{d}T19:00").replace(tzinfo=CAIRO)
    # A teacher whose device is in Riyadh: 19:00 there.
    world.t2.timezone = "Asia/Riyadh"; world.t2.save(update_fields=["timezone"])
    sid2 = create(world.t2, key="tz-riyadh-1", student=world.s2.pk, date=d, time="19:00").json()["id"]
    assert SessionOccurrence.objects.get(pk=sid2).starts_at.astimezone(ZoneInfo("Asia/Riyadh")).strftime("%H:%M") == "19:00"


def test_double_tap_creates_one_session(world, django_capture_on_commit_callbacks):
    a = create(world.t1, key="double-0001", capture=django_capture_on_commit_callbacks, student=world.s1.pk)
    b = create(world.t1, key="double-0001", capture=django_capture_on_commit_callbacks, student=world.s1.pk)
    assert a.status_code == 201 and b.status_code == 200 and a.json()["id"] == b.json()["id"]
    assert SessionOccurrence.objects.filter(teacher=world.t1).count() == 1 and Booking.objects.count() == 1
    assert Notification.objects.filter(recipient=world.s1, kind="booking_created").count() == 1
    # A new form (new request id) for another time is a new session.
    c = create(world.t1, key="double-0002", student=world.s1.pk, date=day(4))
    assert c.status_code == 201 and c.json()["id"] != a.json()["id"]
    assert create(world.t1, key="short").json()["code"] == "invalid"               # a request id is required


def test_authorization(world):
    assert create(world.s1, student=world.s1.pk).status_code == 403                  # students
    assert create(world.p1, student=world.s1.pk).status_code == 403                  # parents
    r = create(world.t1, key="not-mine-01", student=world.s2.pk)                     # s2 belongs to t2
    assert r.status_code == 400 and "غير مرتبط" in r.json()["fields"]["student"][0]
    other = Circle.objects.create(name="حلقة غيري", teacher=world.t2, capacity=5, state="published")
    r = create(world.t1, key="not-mine-02", circle=other.pk)
    assert r.status_code == 400 and r.json()["fields"]["circle"]
    assert not SessionOccurrence.objects.exists()
    from rest_framework.test import APIClient

    assert APIClient().post(URL, {}, format="json").status_code in (401, 403)               # signed out


def test_circle_session_books_and_tells_active_members(world, django_capture_on_commit_callbacks):
    c = Circle.objects.create(name="حلقة الفجر", teacher=world.t1, capacity=10, state="published")
    s3 = make_user("s3@x.test")
    CircleMember.objects.create(circle=c, student=world.s1)
    CircleMember.objects.create(circle=c, student=s3)
    CircleMember.objects.create(circle=c, student=world.s2, active=False)
    r = create(world.t1, key="circle-0001", capture=django_capture_on_commit_callbacks, circle=c.pk, topic="review")
    assert r.status_code == 201, r.json()
    occ = SessionOccurrence.objects.get(pk=r.json()["id"])
    assert occ.kind == "group" and occ.capacity == 10
    assert set(Booking.objects.filter(occurrence=occ, status="confirmed").values_list("student", flat=True)) == {world.s1.pk, s3.pk}
    assert Notification.objects.filter(kind="booking_created", recipient__in=[world.s1, s3]).count() == 2
    assert not Notification.objects.filter(recipient=world.s2).exists()


def test_overlap_and_validation_messages_are_arabic(world):
    assert create(world.t1, key="ovl-000001", student=world.s1.pk).status_code == 201
    r = create(world.t1, key="ovl-000002", student=world.s1.pk)                     # same time
    assert r.status_code == 409 and r.json()["message"] == "يتعارض هذا الموعد مع جلسة أخرى لديك." and r.json()["fields"]["time"]
    assert SessionOccurrence.objects.filter(teacher=world.t1).count() == 1
    past = (timezone.now().astimezone(CAIRO) - timedelta(days=1)).date().isoformat()
    r = create(world.t1, key="past-00001", student=world.s1.pk, date=past)
    assert r.status_code == 400 and "بعد ربع ساعة" in r.json()["fields"]["time"][0]
    r = create(world.t1, key="who-000001")
    assert r.status_code == 400 and r.json()["fields"]["student"] == ["اختر طالبًا أو حلقة."]


def test_teacher_can_cancel_and_reschedule_a_session_made_without_google(world, django_capture_on_commit_callbacks):
    sid = create(world.t1, key="manage-001", capture=django_capture_on_commit_callbacks, student=world.s1.pk).json()["id"]
    c = client_for(world.t1)
    r = c.patch(f"{URL}/{sid}", {"time": "20:00"}, format="json")
    assert r.status_code == 200 and SessionOccurrence.objects.get(pk=sid).starts_at.astimezone(CAIRO).strftime("%H:%M") == "20:00"
    with django_capture_on_commit_callbacks(execute=True):
        r = c.post(f"{URL}/{sid}/cancel", {"reason": "ظرف طارئ"}, format="json")
    assert r.status_code == 200 and SessionOccurrence.objects.get(pk=sid).status == "cancelled"
    assert Notification.objects.filter(recipient=world.s1, kind="booking_cancelled").exists()
    assert client_for(world.t2).get(f"{URL}/{sid}").status_code == 404              # another teacher's session
    r = c.post(f"{URL}/{sid}/retry")
    assert r.status_code == 409


def test_retry_without_google_explains_and_changes_nothing(world):
    sid = create(world.t1, key="retry-0001", student=world.s1.pk).json()["id"]
    r = client_for(world.t1).post(f"{URL}/{sid}/retry")
    assert r.status_code == 409 and r.json()["code"] == "google_not_connected" and "يدويًا" in r.json()["message"]
    assert SessionOccurrence.objects.get(pk=sid).status == "scheduled"


def test_a_google_crash_never_undoes_the_session(world, g, monkeypatch, django_capture_on_commit_callbacks):
    """Google connected, then something unexpected breaks while creating the event: the session stays."""
    connect(world.t1)

    def boom(ev_id):
        raise RuntimeError("network stack exploded")

    monkeypatch.setattr(sync, "try_create", boom)
    r = create(world.t1, key="crash-0001", capture=django_capture_on_commit_callbacks, student=world.s1.pk)
    assert r.status_code == 201, r.json()
    occ = SessionOccurrence.objects.get(pk=r.json()["id"])
    ev = GoogleEvent.objects.get(occurrence=occ)
    assert occ.status == "scheduled" and ev.sync_status == "failed" and ev.last_error == "unexpected"
    assert Booking.objects.filter(occurrence=occ).count() == 1
    assert Notification.objects.filter(recipient=world.s1, kind="booking_created").count() == 1
