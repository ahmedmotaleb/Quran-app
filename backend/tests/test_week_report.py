"""«جلسات الأسبوع» in the admin portal (owner request 22 Nov 2026): every session of a Saturday–Friday week (Cairo),
its students and attendance, its result, and totals per teacher."""
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest
from django.utils import timezone

from apps.accounts.models import Role
from apps.scheduling.models import Booking, SessionOccurrence
from apps.scheduling.week_report import week_bounds

from .conftest import client_for, make_user

pytestmark = pytest.mark.django_db
CAIRO = ZoneInfo("Africa/Cairo")
URL = "/api/v1/admin/sessions/week"


def sess(teacher, start, minutes=45, students=(), att=None, **kw):
    o = SessionOccurrence.objects.create(teacher=teacher, starts_at=start, ends_at=start + timedelta(minutes=minutes),
                                         capacity=max(1, len(students)), kind="group" if len(students) > 1 else "individual", **kw)
    for s in students:
        Booking.objects.create(occurrence=o, student=s, idempotency_key=f"w-{o.pk}-{s.pk}", attendance=(att or {}).get(s.pk, ""))
    return o


def test_week_runs_saturday_to_friday_in_cairo():
    sat, start, end = week_bounds(date(2026, 11, 25))            # a Wednesday
    assert sat == date(2026, 11, 21) and sat.weekday() == 5
    assert start == datetime(2026, 11, 21, 0, 0, tzinfo=CAIRO) and end == datetime(2026, 11, 28, 0, 0, tzinfo=CAIRO)
    assert week_bounds(date(2026, 11, 21))[0] == date(2026, 11, 21) and week_bounds(date(2026, 11, 27))[0] == date(2026, 11, 21)


def test_the_weeks_sessions_with_results_attendance_and_teacher_totals(world):
    s3 = make_user("s3@x.test", full_name="سارة")
    last_week = (timezone.now().astimezone(CAIRO) - timedelta(days=7)).date()
    sat, _, _ = week_bounds(last_week)
    at = lambda d, h: datetime.combine(sat + timedelta(days=d), time(h), CAIRO)
    held = sess(world.t1, at(0, 18), 60, [world.s1, s3], {world.s1.pk: "present", s3.pk: "absent"}, title="حلقة المساء")
    gone = sess(world.t1, at(1, 18), 45, [world.s1], {world.s1.pk: "absent"})
    unmarked = sess(world.t2, at(2, 10), 45, [world.s2])
    cancelled = sess(world.t2, at(3, 10), 45, [world.s2], status="cancelled")
    sess(world.t1, at(4, 9), 45)                                             # an open time nobody booked: not a session
    sess(world.t1, at(9, 9), 45, [world.s1])                                 # next week: not listed
    r = client_for(world.admin).get(URL, {"start": (sat + timedelta(days=3)).isoformat()})
    assert r.status_code == 200, r.json()
    d = r.json()
    assert d["week_start"] == sat.isoformat() and d["week_end"] == (sat + timedelta(days=6)).isoformat()
    assert [x["id"] for x in d["results"]] == [held.pk, gone.pk, unmarked.pk, cancelled.pk]
    by = {x["id"]: x for x in d["results"]}
    assert by[held.pk]["result"] == "held" and by[held.pk]["result_label"] == "انعقدت" and by[held.pk]["title"] == "حلقة المساء"
    assert by[held.pk]["attendance"]["present"] == 1 and by[held.pk]["attendance"]["absent"] == 1 and len(by[held.pk]["students"]) == 2
    assert by[gone.pk]["result"] == "absent" and by[unmarked.pk]["result"] == "unmarked" and by[cancelled.pk]["result"] == "cancelled"
    s = d["summary"]
    assert (s["sessions"], s["held"], s["absent"], s["unmarked"], s["cancelled"]) == (4, 1, 1, 1, 1)
    assert s["students_present"] == 1 and s["students_absent"] == 2 and s["held_minutes"] == 60
    t1 = next(t for t in d["teachers"] if t["id"] == world.t1.pk)
    assert (t1["sessions"], t1["held"], t1["minutes"], t1["present"]) == (2, 1, 60, 1)
    only = client_for(world.admin).get(URL, {"start": sat.isoformat(), "teacher": world.t2.pk, "result": "unmarked"}).json()
    assert [x["id"] for x in only["results"]] == [unmarked.pk] and only["summary"]["sessions"] == 2
    assert client_for(world.admin).get(URL, {"start": d["next"]}).json()["week_start"] == (sat + timedelta(days=7)).isoformat()


def test_current_week_defaults_and_marks_upcoming_and_in_progress(world):
    now = timezone.now()
    live = sess(world.t1, now - timedelta(minutes=10), 45, [world.s1])
    later = sess(world.t2, now + timedelta(hours=1), 45, [world.s2])
    d = client_for(world.admin).get(URL).json()
    assert d["is_current"] is True
    res = {x["id"]: x["result"] for x in d["results"]}
    if week_bounds(now.astimezone(CAIRO).date())[2] > now + timedelta(hours=1):   # both in this week
        assert res[live.pk] == "in_progress" and res[later.pk] == "upcoming"


def test_only_admins_with_sessions_view(world):
    assert client_for(world.t1).get(URL).status_code == 403
    assert client_for(world.s1).get(URL).status_code == 403
    assert client_for(world.admin).get(URL, {"start": "x"}).status_code == 400
    limited = make_user("lim@x.test", Role.ADMIN, is_staff=True, owner=False)
    assert client_for(limited).get(URL).status_code == 403
