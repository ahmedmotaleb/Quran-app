"""Meeting links, joining, and 15-minute session reminders (owner request, 14 Nov 2026)."""
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from zoneinfo import ZoneInfo

import pytest
from django.core.management import call_command
from django.utils import timezone

from apps.notifications.models import Notification, PushSubscription
from apps.scheduling import alarm, reminders
from apps.scheduling.meeting import InvalidMeetingLink, normalize, provider_for
from apps.scheduling.models import Booking, SessionOccurrence

from .conftest import client_for, make_user, occurrence
from .test_push import FakePush, keys  # noqa: F401  (fixture)

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("commit_now")]
BODY15 = "حلقتك هتبدأ بعد 15 دقيقة. استعد للانضمام إلى الجلسة."


def book(o, student):
    return Booking.objects.create(occurrence=o, student=student, idempotency_key=f"{o.pk}-{student.pk}")


def soon(user=None):
    qs = Notification.objects.filter(kind="session_soon")
    return qs.filter(recipient=user) if user else qs


# ---- 1. meeting URL normalization -------------------------------------------------------------------------------------
@pytest.mark.parametrize("raw,saved,provider", [
    ("meet.google.com/mes-bjhv-zzf", "https://meet.google.com/mes-bjhv-zzf", "google_meet"),
    ("  https://meet.google.com/mes-bjhv-zzf \n", "https://meet.google.com/mes-bjhv-zzf", "google_meet"),
    ("http://meet.google.com/mes-bjhv-zzf", "https://meet.google.com/mes-bjhv-zzf", "google_meet"),
    ("HTTPS://meet.google.com/abc-defg-hij?authuser=1", "https://meet.google.com/abc-defg-hij?authuser=1", "google_meet"),
    ("​meet.google.com/abc-defg-hij‏", "https://meet.google.com/abc-defg-hij", "google_meet"),
    ("us02web.zoom.us/j/8812345678?pwd=AbC12", "https://us02web.zoom.us/j/8812345678?pwd=AbC12", "zoom"),
    ("teams.microsoft.com/l/meetup-join/19%3ameeting_X%40thread.v2/0", "https://teams.microsoft.com/l/meetup-join/19%3ameeting_X%40thread.v2/0", "teams"),
    ("meet.jit.si/HalqaRoom-12", "https://meet.jit.si/HalqaRoom-12", "jitsi"),
])
def test_links_are_normalized_keeping_ids_paths_and_queries(raw, saved, provider):
    assert normalize(raw) == saved and provider_for(normalize(raw)) == provider
    assert normalize(saved) == saved                                              # never a second https://


@pytest.mark.parametrize("raw", ["javascript:alert(1)", "data:text/html,x", "ftp://meet.google.com/a", "https://https://meet.google.com/x",
                                 "evil.example/meet.google.com/abc", "meet.google.com.evil.example/abc", "https://zoom.us/s/123?zak=x",
                                 "https://user:pw@meet.google.com/abc-defg-hij", "meet.google.com/"])
def test_unsafe_or_foreign_links_are_refused(raw):
    with pytest.raises(InvalidMeetingLink):
        provider_for(normalize(raw))


def test_teacher_saves_a_link_without_https_and_the_normalized_link_is_stored(world):
    o = occurrence(world.t1, in_hours=3)
    c = client_for(world.t1)
    r = c.put(f"/api/v1/teacher/occurrences/{o.pk}/meeting", {"url": "meet.google.com/mes-bjhv-zzf"}, format="json")
    assert r.status_code == 200, r.content
    o.refresh_from_db()
    assert o.meeting_url == "https://meet.google.com/mes-bjhv-zzf" and o.meeting_provider == "google_meet"
    r = c.put(f"/api/v1/teacher/occurrences/{o.pk}/meeting", {"url": "javascript:alert(1)"}, format="json")
    assert r.status_code == 400 and r.json()["fields"]["url"]
    o.refresh_from_db()
    assert o.meeting_url == "https://meet.google.com/mes-bjhv-zzf"                  # unchanged by the refused one
    # another teacher cannot set (or read) it
    assert client_for(world.t2).put(f"/api/v1/teacher/occurrences/{o.pk}/meeting", {"url": "meet.jit.si/x"}, format="json").status_code == 404


# ---- 2. joining: only the booked student (in the join window) and the teacher get the link -------------------------------
def test_only_participants_get_the_private_link(world):
    o = occurrence(world.t1, in_hours=0.05, meeting_url="https://meet.google.com/abc-defg-hij", meeting_provider="google_meet")
    b = book(o, world.s1)
    r = client_for(world.s1).post(f"/api/v1/bookings/{b.pk}/join")
    assert r.status_code == 200 and r.json()["url"] == "https://meet.google.com/abc-defg-hij" and r.json()["provider_label"] == "Google Meet"
    for other in (world.s2, world.p1):
        assert client_for(other).post(f"/api/v1/bookings/{b.pk}/join").status_code in (403, 404)
    row = next(x for x in client_for(world.s1).get("/api/v1/bookings").json()["results"] if x["id"] == b.pk)
    assert row["meeting_provider"] == "Google Meet" and row["has_meeting_link"] and "meeting_url" not in row  # the card: platform, never the link
    assert "abc-defg-hij" not in str(client_for(world.s2).get("/api/v1/bookings").json())


# ---- 3. the 15-minute reminder ----------------------------------------------------------------------------------------------
def test_reminder_at_t_minus_15_for_student_and_teacher_once(world, keys, monkeypatch):  # noqa: F811
    fake = FakePush(monkeypatch)
    for u in (world.s1, world.t1):
        PushSubscription.objects.create(user=u, endpoint=f"https://fcm.googleapis.com/fcm/send/soon-{u.pk}", p256dh="p", auth="a", device="Android")
    o = occurrence(world.t1, in_hours=0.5)                     # 30 minutes ahead
    book(o, world.s1)
    assert not soon().exists()                                 # not yet (booked 30 min ahead: an alarm, no notice)
    assert reminders.send_due(o.starts_at - timedelta(minutes=16)) == 0
    assert reminders.send_due(o.starts_at - timedelta(minutes=15)) == 2
    for u in (world.s1, world.t1):
        n = soon(u).get()
        assert (n.title, n.body) == ("الحلقة | تذكير بالجلسة", BODY15)
        assert n.push_status == "sent" and n.push_attempts == 1        # delivery attempted and recorded (not "delivered")
    assert soon(world.s1).get().data["booking"] and soon(world.t1).get().data["occurrence"] == o.pk
    assert sorted(p["title"] for _, p in fake.sent) == ["الحلقة | تذكير بالجلسة"] * 2
    assert reminders.send_due(o.starts_at - timedelta(minutes=14)) == 0 and soon().count() == 2   # never twice
    assert reminders.send_due(o.starts_at + timedelta(minutes=1)) == 0                            # never after the start


def test_moved_session_is_reminded_for_the_new_time_only(world):
    o = occurrence(world.t1, in_hours=2)
    book(o, world.s1)
    old_start = o.starts_at
    o.starts_at, o.ends_at = old_start + timedelta(hours=3), old_start + timedelta(hours=3, minutes=45)
    o.save()
    assert reminders.send_due(old_start - timedelta(minutes=15)) == 0               # the old time is gone
    assert reminders.send_due(o.starts_at - timedelta(minutes=15)) == 2


def test_cancelled_or_completed_sessions_are_never_reminded(world):
    for i, status in enumerate((SessionOccurrence.Status.CANCELLED, SessionOccurrence.Status.COMPLETED)):
        o = occurrence(world.t1, in_hours=1 + 2 * i)
        book(o, world.s1)
        SessionOccurrence.objects.filter(pk=o.pk).update(status=status)
        assert reminders.send_due(o.starts_at - timedelta(minutes=15)) == 0
    o = occurrence(world.t1, in_hours=6)
    b = book(o, world.s1)
    Booking.objects.filter(pk=b.pk).update(status=Booking.Status.CANCELLED)       # a cancelled booking: nobody is reminded
    assert reminders.send_due(o.starts_at - timedelta(minutes=15)) == 0
    assert not soon().exists()


def test_booked_less_than_15_minutes_before_is_reminded_at_once_never_in_the_past(world):
    o = occurrence(world.t1, in_hours=8 / 60)                  # 8 minutes ahead
    book(o, world.s1)                                          # the booking's commit triggers it (no alarm in the past)
    n = soon(world.s1).get()
    assert n.body.startswith("حلقتك هتبدأ بعد 8 دقائق") or n.body.startswith("حلقتك هتبدأ بعد 7 دقائق")
    assert soon(world.t1).exists()


def test_alarm_is_set_for_t_minus_15_and_moved_with_the_session(world, settings, monkeypatch):
    settings.REMINDER_TASKS_QUEUE = "projects/p/locations/europe-west1/queues/halqa-reminders"
    settings.REMINDER_TASKS_URL = "https://halqa.example/api/v1/internal/session-reminders"
    settings.REMINDER_TASKS_SECRET = "s3cret"
    calls = []

    class R:
        status_code = 200
        text = ""

    monkeypatch.setattr(alarm, "_token", lambda: "tok")
    monkeypatch.setattr(alarm.requests, "post", lambda url, json, headers, timeout: calls.append((url, json, headers)) or R())
    o = occurrence(world.t1, in_hours=3)
    book(o, world.s1)
    t = calls[-1][1]["task"]
    assert calls[-1][0].endswith("/queues/halqa-reminders/tasks") and calls[-1][2]["Authorization"] == "Bearer tok"
    assert t["scheduleTime"] == (o.starts_at - timedelta(minutes=15)).astimezone(dt_timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert t["httpRequest"]["url"] == settings.REMINDER_TASKS_URL and t["httpRequest"]["headers"]["X-Halqa-Task"] == "s3cret"
    first = t["name"]
    o.starts_at += timedelta(hours=1)
    o.ends_at += timedelta(hours=1)
    o.save()
    assert calls[-1][1]["task"]["name"] != first                    # a new alarm for the new time
    n = len(calls)
    o.summary = "تعديل لا يغيّر الوقت"
    o.save()
    assert len(calls) == n                                          # no alarm for unrelated edits


def test_internal_endpoint_needs_the_secret(world, settings):
    settings.REMINDER_TASKS_SECRET = "s3cret"
    o = occurrence(world.t1, in_hours=0.5)
    book(o, world.s1)
    url = "/api/v1/internal/session-reminders"
    from rest_framework.test import APIClient

    assert APIClient().post(url).status_code == 404
    assert APIClient().post(url, HTTP_X_HALQA_TASK="wrong").status_code == 404
    settings.REMINDER_TASKS_SECRET = ""
    assert APIClient().post(url, HTTP_X_HALQA_TASK="").status_code == 404            # unconfigured: closed
    settings.REMINDER_TASKS_SECRET = "s3cret"
    assert APIClient().post(url, HTTP_X_HALQA_TASK="s3cret").status_code == 200


def test_cairo_dst_uses_the_real_instant(world):
    """Cairo moves to summer time on the last Friday of April (24 Apr 2026, 00:00 → 01:00). A session at 01:10 local
    that night is reminded exactly 15 real minutes before it (00:55 wall time no longer exists in Cairo)."""
    cairo = ZoneInfo("Africa/Cairo")
    start = datetime(2026, 4, 24, 1, 10, tzinfo=cairo)
    o = SessionOccurrence.objects.create(teacher=world.t1, starts_at=start, ends_at=start + timedelta(minutes=45))
    Booking.objects.create(occurrence=o, student=world.s1, idempotency_key="dst")
    real = start.astimezone(dt_timezone.utc)          # 22:10 UTC; Python's wall-clock arithmetic on Cairo times would be wrong here
    assert real.isoformat() == "2026-04-23T22:10:00+00:00"
    assert reminders.send_due(real - timedelta(minutes=16)) == 0
    assert reminders.send_due(real - timedelta(minutes=15)) == 2
    assert soon(world.s1).get().data["starts_at"] == "2026-04-23T22:10:00+00:00"


def test_safety_nets_catch_a_missed_alarm(world):
    o = occurrence(world.t1, in_hours=0.5)
    book(o, world.s1)
    from unittest import mock

    with mock.patch("django.utils.timezone.now", return_value=o.starts_at - timedelta(minutes=14)):
        client_for(world.s2).get("/api/v1/notifications/unread")       # anyone's app open: the due reminders go out
    assert soon(world.s1).exists() and soon(world.t1).exists()
    Notification.objects.filter(kind="session_soon").delete()
    with mock.patch("django.utils.timezone.now", return_value=o.starts_at - timedelta(minutes=10)):
        call_command("session_reminders")                              # the hourly job, too
    assert soon().count() == 2


def test_existing_bookings_flow_is_unaffected(world):
    lone = make_user("lone-soon@x.test")
    o = occurrence(world.t1, in_hours=48)
    b = book(o, lone)
    assert Booking.objects.get(pk=b.pk).status == Booking.Status.CONFIRMED and not soon().exists()
