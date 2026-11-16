"""Sessions may start now (owner report 16 Nov 2026): the 15-minute advance rule on «إنشاء جلسة» is gone.

Root cause: integrations/views._start() refused any start less than 15 minutes ahead; weekly-series generation skipped
starts within 5 minutes; and the reminder code ignored a session whose whole-minute start had just passed, so a
session starting now got no «تذكير». The 15-minute reminder stays a notification only.
Times are taken relative to the real server clock (the authority), in the teacher's zone (Africa/Cairo).
"""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from django.utils import timezone

from apps.accounts.models import TeacherAssignment
from apps.notifications.models import Notification
from apps.scheduling import series as S
from apps.scheduling.models import Booking, RecurringSessionRule, SessionOccurrence

from .conftest import client_for, make_user

pytestmark = pytest.mark.django_db
CAIRO = ZoneInfo("Africa/Cairo")
URL = "/api/v1/teacher/sessions"


@pytest.fixture(autouse=True)
def no_google(settings):
    settings.GOOGLE_CLIENT_ID = settings.GOOGLE_CLIENT_SECRET = ""
    settings.GOOGLE_FAKE = False


@pytest.fixture
def w(world):
    world.s3 = make_user("s3@x.test")
    TeacherAssignment.objects.create(teacher=world.t1, student=world.s3)
    return world


def at(minutes: int) -> dict:
    """The Cairo date and HH:MM `minutes` from the current server minute (16:00 → 16:05 for +5)."""
    t = timezone.now().astimezone(CAIRO).replace(second=0, microsecond=0) + timedelta(minutes=minutes)
    return {"date": t.date().isoformat(), "time": t.strftime("%H:%M")}


def post(teacher, cap, key, **body):
    with cap(execute=True):
        return client_for(teacher).post(URL, {"topic": "hifz", "minutes": 45, **body}, format="json", HTTP_IDEMPOTENCY_KEY=key)


@pytest.mark.parametrize("offset", [0, 1, 5, 10])
def test_now_and_the_next_minutes_are_accepted(w, django_capture_on_commit_callbacks, offset):
    r = post(w.t1, django_capture_on_commit_callbacks, f"soon-{offset:04d}", students=[w.s1.pk], kind="individual", **at(offset))
    assert r.status_code == 201, r.json()
    occ = SessionOccurrence.objects.get(pk=r.json()["id"])
    assert occ.starts_at.astimezone(CAIRO).strftime("%H:%M") == at(offset)["time"]


def test_a_past_start_is_rejected(w, django_capture_on_commit_callbacks):
    r = post(w.t1, django_capture_on_commit_callbacks, "past-00005", students=[w.s1.pk], kind="individual", **at(-5))
    assert r.status_code == 400 and "هذا الوقت مضى" in r.json()["fields"]["time"][0]
    assert not SessionOccurrence.objects.exists()


def test_start_now_group_session_notifies_everyone_at_once_and_join_is_open(w, django_capture_on_commit_callbacks):
    before = timezone.now()
    r = post(w.t1, django_capture_on_commit_callbacks, "now-group-01", start_now=True, students=[w.s1.pk, w.s3.pk], kind="group",
             meeting_url="meet.google.com/abc-defg-hij")
    assert r.status_code == 201, r.json()
    occ = SessionOccurrence.objects.get(pk=r.json()["id"])
    assert occ.kind == "group" and abs((occ.starts_at - before.replace(second=0, microsecond=0)).total_seconds()) <= 60   # the server's minute
    for s in (w.s1, w.s3):
        assert Notification.objects.filter(recipient=s, kind="booking_created").count() == 1          # booked
        soon = Notification.objects.get(recipient=s, kind="session_soon")                            # and reminded at once
        assert soon.body == "حلقتك تبدأ الآن تقريبًا. انضم إلى الجلسة." and soon.push_status != ""
        b = Booking.objects.get(occurrence=occ, student=s)
        j = client_for(s).post(f"/api/v1/bookings/{b.pk}/join")
        assert j.status_code == 200 and j.json()["url"] == "https://meet.google.com/abc-defg-hij"
        assert client_for(s).get(f"/api/v1/bookings/{b.pk}").json()["can_join"] is True
    assert Notification.objects.filter(recipient=w.t1, kind="session_soon").count() == 1
    assert Notification.objects.filter(recipient=w.t1, kind="session_created").count() == 1


def test_a_session_ten_minutes_ahead_is_reminded_at_once_and_one_an_hour_ahead_is_not(w, django_capture_on_commit_callbacks):
    post(w.t1, django_capture_on_commit_callbacks, "in10-00001", students=[w.s1.pk], kind="individual", **at(10))
    assert Notification.objects.get(recipient=w.s1, kind="session_soon").body.startswith("حلقتك هتبدأ بعد")
    post(w.t1, django_capture_on_commit_callbacks, "in60-00001", students=[w.s3.pk], kind="individual", **at(60))
    assert not Notification.objects.filter(recipient=w.s3, kind="session_soon").exists()                # its alarm reminds at T−15


def test_overlapping_sessions_are_still_rejected(w, django_capture_on_commit_callbacks):
    assert post(w.t1, django_capture_on_commit_callbacks, "ovl-now-01", start_now=True, students=[w.s1.pk], kind="individual").status_code == 201
    r = post(w.t1, django_capture_on_commit_callbacks, "ovl-now-02", students=[w.s3.pk], kind="individual", **at(5))
    assert r.status_code == 409 and r.json()["code"] == "overlap"


def test_start_now_without_date_and_time_needs_the_flag(w, django_capture_on_commit_callbacks):
    r = post(w.t1, django_capture_on_commit_callbacks, "nodate-001", students=[w.s1.pk], kind="individual")
    assert r.status_code == 400 and "ابدأ جلسة الآن" in r.json()["fields"]["time"][0]


def test_weekly_series_creates_a_slot_starting_now_and_keeps_generating(w):
    now = timezone.now().astimezone(CAIRO).replace(second=0, microsecond=0)
    rule = RecurringSessionRule.objects.create(teacher=w.t1, kind="individual", timezone="Africa/Cairo", starts_on=now.date())
    rule.slots.create(weekday=now.weekday(), start_time=now.time(), minutes=45)
    rule.participants.create(student=w.s1)
    out = S.generate(rule)
    starts = sorted(o.starts_at.astimezone(CAIRO) for o in SessionOccurrence.objects.filter(series=rule))
    assert starts[0] == now and len(starts) >= 2 and out["created"] == len(starts)                  # today's, then weekly
    assert S.generate(rule)["created"] == 0
