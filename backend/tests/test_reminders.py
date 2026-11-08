"""Daily Quran reminders: local-time hours, quiet hours, one per run, once per day, only with something left to do,
only to students with an active push device and the «تذكيرات القرآن» preference on; generic lock-screen text."""
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from zoneinfo import ZoneInfo

import pytest
from django.utils import timezone

from apps.learning.models import Assignment
from apps.notifications.models import Notification, PushSubscription, ReminderSettings
from apps.notifications.push import payload_for
from apps.notifications.reminders import run
from apps.quran.models import ReadingPosition

from .conftest import client_for

pytestmark = pytest.mark.django_db
URL = "/api/v1/me/reminders"


def device(u):
    return PushSubscription.objects.create(user=u, endpoint=f"https://push.example/{u.pk}", p256dh="p", auth="a")


def local_hour(u, now=None):
    return (now or timezone.now()).astimezone(ZoneInfo(u.timezone or "Africa/Cairo")).hour


def only(u, kind, **kw):
    """Settings with just this kind on, due at the current local hour, no quiet hours."""
    off = {f"{k}_on": False for k in ReminderSettings.KINDS}
    s = ReminderSettings.objects.update_or_create(user=u, defaults={**off, f"{kind}_on": True, f"{kind}_hour": local_hour(u),
                                                                    "quiet_start": 0, "quiet_end": 0, **kw})[0]
    return backdate(s)


def backdate(s, days=3):
    """Settings saved before today's moments (changing them never fires a reminder at once)."""
    ReminderSettings.objects.filter(pk=s.pk).update(updated_at=timezone.now() - timedelta(days=days))
    s.refresh_from_db()
    return s


def task(u, kind="hifz", due=timedelta(days=1), status="not_started"):
    return Assignment.objects.create(student=u, teacher=u.teacher_assignments.first().teacher if u.teacher_assignments.exists() else u,
                                     kind=kind, title="مهمة", surah=67, ayah_from=1, ayah_to=5, due_at=timezone.now() + due, status=status)


def sent(u, kind=None):
    qs = Notification.objects.filter(recipient=u, kind__startswith="reminder_")
    return qs.filter(kind=f"reminder_{kind}") if kind else qs


def test_reading_reminder_once_a_day_at_the_local_hour(world):
    device(world.s1); only(world.s1, "reading")
    assert run()["reading"] == 1
    n = sent(world.s1, "reading").get()
    assert n.link == "/mushaf" and n.data == {"screen": "mushaf"}
    assert run()["reading"] == 0 and sent(world.s1).count() == 1                  # no duplicate on the next run


def test_skipped_once_the_student_read_today(world):
    device(world.s1); only(world.s1, "reading")
    ReadingPosition.objects.create(user=world.s1, surah=2, ayah=5)               # saved now = read today
    assert run()["reading"] == 0 and not sent(world.s1).exists()


def test_local_time_zone_catch_up_and_quiet_hours(world):
    device(world.s1)
    world.s1.timezone = "Asia/Tokyo"; world.s1.save(update_fields=["timezone"])
    h = local_hour(world.s1)
    if h < 4:
        pytest.skip("needs three earlier hours in the same local day")
    only(world.s1, "reading", reading_hour=h - 3)                                # missed runs: caught up the same day
    assert run()["reading"] == 1
    Notification.objects.all().delete()
    only(world.s1, "reading", reading_hour=(h + 1) % 24)                          # not yet
    assert run()["reading"] == 0
    only(world.s1, "reading", quiet_start=h, quiet_end=(h + 1) % 24)              # inside quiet hours
    assert run()["reading"] == 0 and not sent(world.s1).exists()


def test_changing_the_hour_never_fires_at_once(world):
    device(world.s1)
    h = local_hour(world.s1)
    if h < 2:
        pytest.skip("needs an earlier hour today")
    s = only(world.s1, "reading", reading_hour=h - 1)
    ReminderSettings.objects.filter(pk=s.pk).update(updated_at=timezone.now())   # saved after today's moment
    assert run()["reading"] == 0                                                  # starts tomorrow
    tomorrow = timezone.now() + timedelta(days=1)
    assert run(tomorrow)["reading"] == 1


def _cairo(u, hour, **kw):
    device(u); u.timezone = "Africa/Cairo"; u.save(update_fields=["timezone"])
    off = {f"{k}_on": False for k in ReminderSettings.KINDS}
    return backdate(ReminderSettings.objects.update_or_create(user=u, defaults={**off, "reading_on": True, "reading_hour": hour,
                                                                                "quiet_start": 0, "quiet_end": 0, **kw})[0], days=400)


def utc(s):
    return datetime.fromisoformat(s).replace(tzinfo=dt_timezone.utc)


def test_cairo_daylight_saving_time_from_the_iana_database(world):
    _cairo(world.s1, 20)
    assert run(utc("2026-06-10T16:30"))["reading"] == 0                           # 19:30 Cairo summer (UTC+3)
    assert run(utc("2026-06-10T17:05"))["reading"] == 1                           # 20:05 Cairo summer
    assert run(utc("2026-12-10T17:05"))["reading"] == 0                           # 19:05 Cairo winter (UTC+2)
    assert run(utc("2026-12-10T18:05"))["reading"] == 1                           # 20:05 Cairo winter
    assert sent(world.s1).count() == 2


def test_fall_back_repeated_hour_sends_once(world):
    # 29 Oct 2026: Cairo goes from 24:00 back to 23:00, so 23:xx happens twice.
    _cairo(world.s1, 23)
    assert run(utc("2026-10-29T20:30"))["reading"] == 1                           # 23:30 +03
    assert run(utc("2026-10-29T21:30"))["reading"] == 0                           # 23:30 +02 again: no duplicate
    assert sent(world.s1).count() == 1


def test_spring_forward_skipped_hour_is_not_missed(world):
    # 24 Apr 2026: Cairo jumps from 00:00 to 01:00, so a 00:00 reminder has no wall time that day.
    _cairo(world.s1, 0)
    assert run(utc("2026-04-23T22:30"))["reading"] == 1                           # 01:30 +03 on the 24th: sent once
    assert run(utc("2026-04-23T23:30"))["reading"] == 0


def test_travel_across_the_date_line_never_duplicates(world):
    device(world.s1)
    world.s1.timezone = "Pacific/Honolulu"; world.s1.save(update_fields=["timezone"])
    backdate(ReminderSettings.objects.create(user=world.s1, reading_hour=20, hifz_on=False, review_on=False, evening_on=False,
                                             quiet_start=0, quiet_end=0), days=400)
    t = utc("2026-11-10T06:10")                                                   # 20:10 on the 9th in Honolulu
    assert run(t)["reading"] == 1
    Notification.objects.filter(recipient=world.s1).update(created_at=t)          # as if sent at that moment
    world.s1.timezone = "Pacific/Kiritimati"; world.s1.save(update_fields=["timezone"])  # now 20:10 on the 10th
    assert run(t + timedelta(minutes=5))["reading"] == 0                           # same reminder, minutes later: not again
    assert run(t + timedelta(days=1))["reading"] == 1                              # the next real day
    assert sent(world.s1).count() == 2


def test_flight_to_a_zone_where_the_hour_passed_is_caught_up(world):
    _cairo(world.s1, 20)
    assert run(utc("2026-11-10T17:30"))["reading"] == 0                           # 19:30 in Cairo: not yet
    world.s1.timezone = "Asia/Dubai"; world.s1.save(update_fields=["timezone"])
    assert run(utc("2026-11-10T18:30"))["reading"] == 1                           # 22:30 in Dubai: past 20:00, sent


def test_hifz_only_with_an_open_memorization_task(world):
    device(world.s1); only(world.s1, "hifz")
    assert run()["hifz"] == 0                                                     # nothing to memorize
    t = task(world.s1, "hifz", status="submitted")
    assert run()["hifz"] == 0                                                     # done already
    t.status = "in_progress"; t.save(update_fields=["status"])
    assert run()["hifz"] == 1
    n = sent(world.s1, "hifz").get()
    assert n.data == {"assignment": t.pk} and n.link == f"/tasks/{t.pk}"         # tap opens that task


def test_review_only_when_due_by_today_and_not_done(world):
    device(world.s1); only(world.s1, "review")
    task(world.s1, "review", due=timedelta(days=3))                               # not due yet
    assert run()["review"] == 0
    task(world.s1, "review", due=timedelta(hours=-2), status="accepted")          # done
    assert run()["review"] == 0
    r = task(world.s1, "review", due=timedelta(hours=-1))                         # overdue, open
    assert run()["review"] == 1 and sent(world.s1, "review").get().data == {"assignment": r.pk}


def test_evening_only_for_unfinished_tasks_due_today(world):
    device(world.s1); only(world.s1, "evening")
    local = timezone.now().astimezone(ZoneInfo(world.s1.timezone or "Africa/Cairo"))
    end_of_day = local.replace(hour=23, minute=59, second=0, microsecond=0)
    Assignment.objects.create(student=world.s1, teacher=world.t1, kind="hifz", title="x", surah=1, ayah_from=1, ayah_to=7,
                              due_at=end_of_day, status="submitted")
    assert run()["evening"] == 0                                                  # today's task is done
    Assignment.objects.create(student=world.s1, teacher=world.t1, kind="review", title="y", surah=1, ayah_from=1, ayah_to=7,
                              due_at=end_of_day, status="not_started")
    assert run()["evening"] == 1


def test_one_reminder_per_run_then_the_next(world):
    device(world.s1)
    h = local_hour(world.s1)
    backdate(ReminderSettings.objects.create(user=world.s1, reading_hour=h, hifz_hour=h, review_on=False, evening_on=False, quiet_start=0, quiet_end=0))
    task(world.s1, "hifz")
    first = run(); second = run(); third = run()
    assert sum(first.values()) == 1 and sum(second.values()) == 1 and sum(third.values()) == 0
    assert {n.kind for n in sent(world.s1)} == {"reminder_reading", "reminder_hifz"}


def test_needs_a_device_the_preference_and_an_active_student(world):
    only(world.s1, "reading")
    assert run()["reading"] == 0                                                  # no push device: nothing
    d = device(world.s1); d.active = False; d.save(update_fields=["active"])
    assert run()["reading"] == 0                                                  # switched-off device
    d.active = True; d.save(update_fields=["active"])
    world.s1.notify_prefs = {"reminders": False}; world.s1.save(update_fields=["notify_prefs"])
    assert run()["reading"] == 0                                                  # «تذكيرات القرآن» off
    world.s1.notify_prefs = {}; world.s1.status = "suspended"; world.s1.save(update_fields=["notify_prefs", "status"])
    assert run()["reading"] == 0
    device(world.t1); only(world.t1, "reading")                                   # teachers never get them
    assert run()["reading"] == 0


def test_student_without_a_teacher_still_gets_the_reading_reminder(world):
    world.s2.teacher_assignments.update(active=False)
    device(world.s2); only(world.s2, "reading")
    assert run()["reading"] == 1


def test_lock_screen_text_is_generic():
    for k in ("reading", "hifz", "review", "evening"):
        p = payload_for(f"reminder_{k}", f"/tasks/7", 12)
        assert set(p) == {"title", "body", "url", "tag"} and p["url"] == "/#/n/12" and p["title"] == "الحلقة"
        assert "سورة" not in p["body"] and "7" not in p["body"]


def test_settings_api(world):
    c = client_for(world.s1)
    d = c.get(URL).json()
    assert d["reading_on"] and d["reading_hour"] == 20 and d["quiet_start"] == 23 and d["timezone"] and d["enabled"] is True
    r = c.put(URL, {"reading_hour": 6, "hifz_on": False}, format="json")         # 06:00 is inside 23:00–07:00
    assert r.status_code == 400 and "ساعات الهدوء" in r.json()["fields"]["reading_hour"][0]
    r = c.put(URL, {"reading_hour": 8, "hifz_on": False, "quiet_start": 22, "quiet_end": 6}, format="json")
    assert r.status_code == 200 and r.json()["reading_hour"] == 8 and r.json()["hifz_on"] is False
    assert c.put(URL, {"reading_hour": 24}, format="json").status_code == 400
    assert client_for(world.t1).get(URL).status_code == 403
    assert client_for(world.p1).put(URL, {}, format="json").status_code == 403
    assert c.patch("/api/v1/me", {"notify_prefs": {"reminders": False}}, format="json").status_code == 200
    assert c.get(URL).json()["enabled"] is False


def test_scheduled_job_runs_the_reminders(world):
    from io import StringIO

    from django.core.management import call_command

    device(world.s1); only(world.s1, "reading")
    out = StringIO()
    call_command("quran_reminders", stdout=out)
    assert "'reading': 1" in out.getvalue()
