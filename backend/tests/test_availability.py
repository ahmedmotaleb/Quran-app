"""Teacher availability across the whole day (owner request, 25 October 2026): ranges anywhere in 00:00–23:59,
computed start times every 15 minutes, conflicts (bookings, circle sessions, blocked time, Google Calendar, gap),
date-only changes, overnight ranges, time zones, concurrency and admin access."""
import threading
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest
from django.db import connection
from django.utils import timezone

from apps.accounts.models import AdminProfile, Role
from apps.core.models import AppSettings, AuditEvent
from apps.scheduling import availability as av
from apps.scheduling import services
from apps.scheduling.models import AvailabilityRule, Booking, Circle, SessionOccurrence

from .conftest import client_for, make_user
from .test_admins import staff, with_mfa

pytestmark = pytest.mark.django_db
CAIRO = ZoneInfo("Africa/Cairo")
UTC = ZoneInfo("UTC")


def ahead(n=3) -> date:
    return datetime.now(CAIRO).date() + timedelta(days=n)


def at(d: date, hh: int, mm: int = 0) -> datetime:
    return datetime.combine(d, time(hh, mm), CAIRO).astimezone(UTC)


def add(c, weekday, start, end, minutes=45):
    return c.post("/api/v1/teacher/availability/rules", {"weekday": weekday, "start": start, "end": end, "session_minutes": minutes}, format="json")


def slots(student, teacher):
    return client_for(student).get(f"/api/v1/teachers/{teacher.pk}/slots", {"days": 21}).json()


def starts(student, teacher, d: date) -> list[str]:
    """Computed start times on local date d, as HH:MM Cairo."""
    out = []
    for x in slots(student, teacher):
        if not str(x["id"]).startswith("s:"):
            continue
        s = datetime.fromisoformat(x["starts_at"]).astimezone(CAIRO)
        if s.date() == d:
            out.append(s.strftime("%H:%M"))
    return out


def token(teacher, start: datetime, minutes=45) -> str:
    return av.token_for(teacher.pk, start, minutes)


def book(student, tok, key=None):
    return client_for(student).post("/api/v1/bookings", {"occurrence": tok}, format="json",
                                    HTTP_IDEMPOTENCY_KEY=key or f"k-{student.pk}-{tok}")


# 1–5: any time of the day -----------------------------------------------------------------------------------
def test_morning_afternoon_and_late_night_ranges(world):
    d = ahead(3)
    c = client_for(world.t1)
    assert add(c, d.weekday(), "06:00", "12:00").status_code == 201          # morning
    assert add(c, d.weekday(), "15:30", "23:45").status_code == 201          # afternoon to late night
    got = starts(world.s1, world.t1, d)
    assert got[0] == "06:00" and "06:15" in got and "11:15" in got and "11:30" not in got   # ends inside 12:00
    assert "15:30" in got and "23:00" in got and "23:15" not in got           # 23:00 + 45 = 23:45
    assert all(int(t[3:]) % 15 == 0 for t in got)


def test_midnight_and_2345_boundaries(world):
    d = ahead(4)
    c = client_for(world.t1)
    assert add(c, d.weekday(), "00:00", "01:00", 30).status_code == 201
    r = add(c, d.weekday(), "23:00", "23:45", 45)
    assert r.status_code == 201 and r.json()["end"] == "23:45"
    got = starts(world.s1, world.t1, d)
    assert got[:3] == ["00:00", "00:15", "00:30"] and "00:45" not in got and got[-1] == "23:00"


def test_example_window_fits_sessions_completely(world):
    d = ahead(5)
    add(client_for(world.t1), d.weekday(), "16:00", "18:00", 45)
    assert starts(world.s1, world.t1, d) == ["16:00", "16:15", "16:30", "16:45", "17:00", "17:15"]


def test_validation(world):
    c = client_for(world.t1)
    wd = ahead(3).weekday()
    assert add(c, wd, "08:00", "12:00").status_code == 201
    assert add(c, wd, "12:00", "16:00").status_code == 201                     # adjacent is fine
    r = add(c, wd, "11:00", "13:00")
    assert r.status_code == 409 and r.json()["code"] == "overlap"
    assert add(c, wd, "08:00", "12:00").json()["message"] == "هذه الفترة مضافة بالفعل."
    assert add(c, wd, "10:00", "10:00").json()["code"] == "invalid"             # zero length
    assert add(c, wd, "25:00", "26:00").json()["code"] == "invalid"             # invalid time
    assert add(c, wd, "18:07", "19:00").json()["fields"]["start"]               # off the 15-minute grid
    assert "أقصر" in add(c, wd, "18:00", "18:30", 45).json()["fields"]["end"][0]  # shorter than the session
    assert add(c, wd, "18:00", "19:00", 50).json()["fields"]["session_minutes"]  # not an allowed length
    assert add(c, 9, "18:00", "19:00").json()["fields"]["weekday"]
    assert AvailabilityRule.objects.filter(teacher=world.t1).count() == 2


def test_overnight_range_and_next_day_overlap(world):
    d = ahead(3)
    c = client_for(world.t1)
    r = add(c, d.weekday(), "22:00", "02:00")
    assert r.status_code == 201 and r.json()["overnight"] is True
    late = starts(world.s1, world.t1, d)
    early = starts(world.s1, world.t1, d + timedelta(days=1))
    assert late[0] == "22:00" and late[-1] == "23:45"
    assert early[0] == "00:00" and early[-1] == "01:15"                       # 01:15 + 45 = 02:00 next day
    nxt = (d.weekday() + 1) % 7
    r = add(c, nxt, "01:00", "03:00")
    assert r.status_code == 409 and r.json()["code"] == "overlap"              # already covered by the overnight range
    assert add(c, nxt, "02:00", "04:00").status_code == 201
    # Sunday night runs into Monday (the week wraps)
    assert add(c, 6, "23:00", "01:00").status_code == 201
    assert add(c, 0, "00:30", "02:00").json()["code"] == "overlap"


# 6–11: conflicts ------------------------------------------------------------------------------------------------
def test_booking_removes_overlapping_starts_and_gap_applies(world):
    d = ahead(3)
    add(client_for(world.t1), d.weekday(), "16:00", "19:00")
    r = book(world.s1, token(world.t1, at(d, 16)))
    assert r.status_code == 201 and r.json()["occurrence"]["starts_at"]
    got = starts(world.s2, world.t1, d)
    assert "16:00" not in got and "16:30" not in got and "16:45" in got        # 16:00–16:45 taken
    cfg = AppSettings.load()
    cfg.session_buffer_minutes = 15
    cfg.save()
    got = starts(world.s2, world.t1, d)
    assert "16:45" not in got and "17:00" in got
    # the booked time is listed as taken (for the waitlist), never as a free start
    taken = [x for x in slots(world.s2, world.t1) if isinstance(x["id"], int)]
    assert [x["seats_left"] for x in taken] == [0]


def test_circle_session_blocks_time(world):
    d = ahead(3)
    add(client_for(world.t1), d.weekday(), "16:00", "20:00")
    circle = Circle.objects.create(name="حلقة المساء", teacher=world.t1, capacity=6, state="published")
    SessionOccurrence.objects.create(teacher=world.t1, kind="group", circle=circle, starts_at=at(d, 17), ends_at=at(d, 18), capacity=6)
    got = starts(world.s1, world.t1, d)
    assert "16:15" in got and "16:30" not in got and "17:45" not in got and "18:00" in got
    assert book(world.s1, token(world.t1, at(d, 17, 30))).json()["code"] == "slot_unavailable"


@pytest.fixture
def gcal(world, monkeypatch):
    from apps.integrations.models import GoogleCalendarConnection

    GoogleCalendarConnection.objects.create(teacher=world.t1, google_account_email="t@example.com", status="active")
    busy = []
    monkeypatch.setattr(av, "_google_events", lambda conn, a, b: list(busy))
    return busy


def test_google_calendar_busy_time_hides_starts_but_keeps_availability(world, gcal):
    d = ahead(3)
    add(client_for(world.t1), d.weekday(), "16:00", "22:00")
    gcal.append((at(d, 18), at(d, 19)))
    got = starts(world.s1, world.t1, d)
    assert "17:15" in got and "17:30" not in got and "18:45" not in got and "19:00" in got
    assert AvailabilityRule.objects.filter(teacher=world.t1).count() == 1      # HALQA availability untouched
    # Booking re-checks Google live: a new personal event appears after the student loaded the list.
    gcal.append((at(d, 20), at(d, 21)))
    assert book(world.s1, token(world.t1, at(d, 20, 15))).json()["code"] == "slot_unavailable"
    day = client_for(world.t1).get("/api/v1/teacher/availability/day", {"date": d.isoformat()}).json()
    assert "calendar" in {s["state"] for s in day["timeline"]}


def test_google_error_never_blocks_booking(world, monkeypatch):
    from apps.integrations.models import GoogleCalendarConnection

    GoogleCalendarConnection.objects.create(teacher=world.t1, google_account_email="t@example.com", status="active")

    def boom(*a):
        raise RuntimeError("unreachable")

    monkeypatch.setattr(av, "_google_events", boom)
    d = ahead(3)
    add(client_for(world.t1), d.weekday(), "16:00", "18:00")
    assert book(world.s1, token(world.t1, at(d, 16))).status_code == 201


def test_date_override_close_extra_and_block(world):
    d = ahead(3)
    c = client_for(world.t1)
    add(c, d.weekday(), "16:00", "22:00")
    r = c.post("/api/v1/teacher/availability/overrides", {"date": d.isoformat(), "kind": "off"}, format="json")
    assert r.status_code == 201
    assert starts(world.s1, world.t1, d) == []
    assert starts(world.s1, world.t1, d + timedelta(days=7))                   # other weeks unchanged
    c.delete(f"/api/v1/teacher/availability/overrides/{r.json()['id']}")
    assert starts(world.s1, world.t1, d)
    # extra time that date only
    assert c.post("/api/v1/teacher/availability/overrides", {"date": d.isoformat(), "kind": "extra", "start": "08:00", "end": "09:00",
                                                             "session_minutes": 30}, format="json").status_code == 201
    assert starts(world.s1, world.t1, d)[:3] == ["08:00", "08:15", "08:30"]
    assert "08:00" not in starts(world.s1, world.t1, d + timedelta(days=7))
    # «حظر وقت» with a private reason
    r = c.post("/api/v1/teacher/availability/overrides", {"date": d.isoformat(), "kind": "blocked", "start": "18:30", "end": "20:00",
                                                          "reason": "موعد شخصي"}, format="json")
    assert r.status_code == 201
    got = starts(world.s1, world.t1, d)
    assert "17:45" in got and "18:00" not in got and "19:45" not in got and "20:00" in got
    assert "موعد شخصي" not in str(slots(world.s1, world.t1))
    assert not AuditEvent.objects.filter(data__icontains="موعد شخصي").exists()
    day = c.get("/api/v1/teacher/availability/day", {"date": d.isoformat()}).json()
    assert any(o["reason"] == "موعد شخصي" for o in day["overrides"])
    assert {"available", "unavailable"} <= {s["state"] for s in day["timeline"]}
    assert c.post("/api/v1/teacher/availability/overrides", {"date": (d - timedelta(days=10)).isoformat(), "kind": "off"},
                  format="json").json()["code"] == "invalid"                    # never in the past


def test_timezone_is_cairo_and_stored_in_utc(world):
    d = ahead(3)
    add(client_for(world.t1), d.weekday(), "16:00", "17:00")
    x = next(s for s in slots(world.s1, world.t1) if str(s["id"]).startswith("s:"))
    start = datetime.fromisoformat(x["starts_at"])
    assert start == at(d, 16) and start.utcoffset() == timedelta(0)
    r = book(world.s1, x["id"])
    occ = SessionOccurrence.objects.get(pk=r.json()["occurrence"]["id"])
    assert occ.starts_at == at(d, 16) and occ.ends_at - occ.starts_at == timedelta(minutes=45)
    info = client_for(world.t1).get("/api/v1/teacher/availability").json()
    assert info["timezone"] == "Africa/Cairo" and info["increment"] == 15 and info["durations"] == [30, 45, 60]


def test_dst_gap_and_fold_are_safe(world):
    """Starts are stepped on the wall clock and checked in UTC: a time skipped by DST is never offered, each session
    lasts exactly its minutes, and nothing ends after its window."""
    AvailabilityRule.objects.create(teacher=world.t1, weekday=6, start_time=time(0), end_time=time(4), timezone="Europe/London",
                                    session_minutes=60, valid_from=date(2027, 1, 1))
    london = ZoneInfo("Europe/London")
    now = datetime(2027, 3, 26, 12, tzinfo=UTC)  # clocks go forward 01:00 → 02:00 on Sunday 28 March 2027
    got = av.compute(world.t1, datetime(2027, 3, 27, tzinfo=UTC), datetime(2027, 3, 29, tzinfo=UTC), now=now)
    local = [x.start.astimezone(london).strftime("%H:%M") for x in got]
    assert not any(t.startswith("01:") for t in local)
    assert all(x.end - x.start == timedelta(hours=1) for x in got)
    assert all(x.end <= datetime(2027, 3, 28, 4, tzinfo=london) for x in got)
    assert av.exists(date(2027, 3, 28), time(1, 30), london) is False


# 12–18: booking --------------------------------------------------------------------------------------------------
def test_student_sees_only_valid_free_times(world):
    d = ahead(3)
    add(client_for(world.t1), d.weekday(), "06:00", "11:00")
    add(client_for(world.t1), d.weekday(), "16:00", "22:00")
    got = starts(world.s1, world.t1, d)
    assert got and all("06:00" <= t <= "10:15" or "16:00" <= t <= "21:15" for t in got)
    assert book(world.s1, token(world.t1, at(d, 12))).json()["code"] == "slot_unavailable"      # outside availability
    assert book(world.s1, token(world.t1, at(d, 6, 10))).json()["code"] == "slot_unavailable"   # off the grid
    assert book(world.s1, token(world.t1, at(d, 10, 30))).json()["code"] == "slot_unavailable"  # would end after 11:00
    assert book(world.s1, "s:abc").status_code == 400
    assert book(world.s1, token(world.t1, at(d, 6))).status_code == 201


@pytest.mark.django_db(transaction=True)
def test_concurrent_students_cannot_double_book_a_teacher(world):
    d = ahead(3)
    add(client_for(world.t1), d.weekday(), "16:00", "18:00")
    s3 = make_user("s3@x.test")
    results = []

    def run(student, tok):
        try:
            services.book_slot(student=student, token=tok, idempotency_key=f"race-{student.pk}")
            results.append("ok")
        except Exception as e:  # noqa: BLE001
            results.append(getattr(e, "code", type(e).__name__))
        finally:
            connection.close()

    ts = [threading.Thread(target=run, args=a) for a in ((world.s1, token(world.t1, at(d, 16))), (world.s2, token(world.t1, at(d, 16))),
                                                           (s3, token(world.t1, at(d, 16, 15))))]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert results.count("ok") == 1, results
    live = SessionOccurrence.objects.filter(teacher=world.t1).exclude(status="cancelled")
    assert live.count() == 1 and Booking.objects.filter(status="confirmed").count() == 1


def test_existing_bookings_survive_and_old_free_rows_do_not_block(world):
    d = ahead(3)
    rule = AvailabilityRule.objects.create(teacher=world.t1, weekday=d.weekday(), start_time=time(16), end_time=time(19),
                                           timezone="Africa/Cairo", session_minutes=45, buffer_minutes=15, valid_from=d - timedelta(days=7))
    services.generate_occurrences(world.t1, start=d, days=1)     # rows of the old fixed-slot model
    rows = list(SessionOccurrence.objects.filter(teacher=world.t1).order_by("starts_at"))
    booked, _ = services.book(student=world.s1, occurrence_id=rows[0].pk, idempotency_key="old")
    before = (booked.occurrence.starts_at, booked.occurrence.ends_at, booked.status)
    got = starts(world.s2, world.t1, d)
    assert "16:00" not in got and "16:45" in got                          # the old free row at 17:00 does not block
    r = book(world.s2, token(world.t1, at(d, 17, 15)))                    # overlaps the old free 17:00 row
    assert r.status_code == 201
    booked.refresh_from_db()
    assert (booked.occurrence.starts_at, booked.occurrence.ends_at, booked.status) == before
    assert SessionOccurrence.objects.get(pk=rows[1].pk).status == "cancelled"   # the unheld old row gave way
    assert rule.pk == AvailabilityRule.objects.get(teacher=world.t1).pk


def test_reschedule_to_a_computed_time(world):
    d = ahead(3)
    add(client_for(world.t1), d.weekday(), "16:00", "19:00")
    b = book(world.s1, token(world.t1, at(d, 16))).json()
    r = client_for(world.s1).post(f"/api/v1/bookings/{b['id']}/reschedule", {"occurrence": token(world.t1, at(d, 16, 15))}, format="json",
                                  HTTP_IDEMPOTENCY_KEY="resched-1")
    assert r.status_code == 200 and datetime.fromisoformat(r.json()["occurrence"]["starts_at"]) == at(d, 16, 15)
    assert Booking.objects.get(pk=b["id"]).status == "cancelled"


def test_increment_setting_30_minutes(world):
    cfg = AppSettings.load()
    cfg.slot_increment_minutes = 30
    cfg.save()
    d = ahead(3)
    c = client_for(world.t1)
    assert add(c, d.weekday(), "16:15", "18:00").json()["fields"]["start"]   # 16:15 is off a 30-minute grid
    add(c, d.weekday(), "16:00", "18:00")
    assert starts(world.s1, world.t1, d) == ["16:00", "16:30", "17:00"]
    admin = client_for(world.admin)
    assert admin.patch("/api/v1/admin/settings", {"slot_increment_minutes": 20}, format="json").status_code == 400
    assert admin.patch("/api/v1/admin/settings", {"session_durations": [30, 7]}, format="json").status_code == 400
    assert admin.patch("/api/v1/admin/settings", {"session_durations": [60, 30, 90], "slot_increment_minutes": 15},
                       format="json").json()["session_durations"] == [30, 60, 90]


# copy, day view, permissions --------------------------------------------------------------------------------------
def test_copy_to_other_days_all_or_nothing(world):
    c = client_for(world.t1)
    add(c, 6, "16:00", "22:00")                       # Sunday
    add(c, 6, "08:00", "10:00")
    r = c.post("/api/v1/teacher/availability/copy", {"from_weekday": 6, "to_weekdays": [0, 1, 2]}, format="json")
    assert r.status_code == 200
    by = {}
    for x in r.json()["rules"]:
        by.setdefault(x["weekday"], []).append((x["start"], x["end"]))
    assert by[0] == by[1] == by[2] == by[6] == [("08:00", "10:00"), ("16:00", "22:00")]
    add(c, 4, "23:00", "09:00")                       # Friday night into Saturday morning
    r = c.post("/api/v1/teacher/availability/copy", {"from_weekday": 6, "to_weekdays": [5]}, format="json")
    assert r.status_code == 409 and r.json()["code"] == "overlap"
    assert not AvailabilityRule.objects.filter(teacher=world.t1, weekday=5).exists()


def test_day_view_separates_ranges_and_sessions(world):
    d = ahead(3)
    c = client_for(world.t1)
    rid = add(c, d.weekday(), "08:00", "12:00").json()["id"]
    add(c, d.weekday(), "16:00", "22:00")
    book(world.s1, token(world.t1, at(d, 16)))
    day = c.get("/api/v1/teacher/availability/day", {"date": d.isoformat()}).json()
    assert [(r["start"], r["end"]) for r in day["weekly"]] == [("08:00", "12:00"), ("16:00", "22:00")]
    assert [s["students"] for s in day["sessions"]] == [[world.s1.full_name]]
    assert {s["state"] for s in day["timeline"]} == {"available", "booked"} and day["bookable_starts"] > 0
    r = c.patch(f"/api/v1/teacher/availability/rules/{rid}", {"start": "06:00"}, format="json")
    assert r.status_code == 200 and r.json()["start"] == "06:00"
    assert c.delete(f"/api/v1/teacher/availability/rules/{rid}").status_code == 204
    assert client_for(world.t2).delete(f"/api/v1/teacher/availability/rules/{rid}").status_code == 404
    acts = list(AuditEvent.objects.filter(action="teacher.availability_changed").values_list("data__op", flat=True))
    assert {"range_added", "range_changed", "range_removed"} <= set(acts)


def test_admin_view_and_edit_by_permission(world):
    owner = with_mfa(world.admin)
    ro = staff("ro@x.test", preset="read_only", owner=owner)
    sess = staff("sess@x.test", preset="sessions", owner=owner)
    base = f"/api/v1/admin/teachers/{world.t1.pk}/availability"
    add(client_for(world.t1), 6, "16:00", "22:00")
    assert client_for(ro).get(base).json()["rules"][0]["start"] == "16:00"
    assert client_for(ro).post(base + "/rules", {"weekday": 0, "start": "08:00", "end": "10:00"}, format="json").status_code == 403
    r = client_for(sess).post(base + "/rules", {"weekday": 0, "start": "08:00", "end": "10:00", "session_minutes": 30}, format="json")
    assert r.status_code == 201
    ev = AuditEvent.objects.get(action="teacher.availability_admin_changed")
    assert ev.actor_id == sess.pk and ev.data["op"] == "range_added"
    assert client_for(world.s1).get("/api/v1/teacher/availability").status_code == 403
    assert client_for(world.p1).get(base).status_code == 403
    assert client_for(owner).get(f"/api/v1/admin/teachers/{world.s1.pk}/availability").status_code == 404
    AdminProfile.objects.filter(user=sess).update(permissions=["teachers.view"])
    assert client_for(sess).delete(f"{base}/rules/{r.json()['id']}").status_code == 403
    assert Role.TEACHER == world.t1.role
