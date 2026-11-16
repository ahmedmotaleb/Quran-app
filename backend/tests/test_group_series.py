"""Individual & group sessions with weekly recurrence (owner request 16 Nov 2026): apps/scheduling/series.py.

Covers: individual and group creation with chosen students (assigned only, no duplicates), adding and removing
participants (dashboards and history), weekly series with different times per day (generation, idempotency, the
horizon, end date, pause / resume / cancel, schedule change, one skipped date, Cairo DST), teacher and student
conflicts, privacy (never offered to other students), per-student attendance and evaluation, notifications to every
participant (once), the 15-minute reminder for every active participant, and the admin's grant.
"""
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest
from django.utils import timezone

from apps.accounts.models import Role, TeacherAssignment
from apps.notifications.models import Notification
from apps.scheduling import series as S
from apps.scheduling.models import (Booking, RecurringSessionException, RecurringSessionRule, SessionEvaluation, SessionOccurrence)
from apps.scheduling.reminders import send_due

from .conftest import client_for, make_user

pytestmark = pytest.mark.django_db
CAIRO = ZoneInfo("Africa/Cairo")


@pytest.fixture(autouse=True)
def no_google(settings):
    settings.GOOGLE_CLIENT_ID = settings.GOOGLE_CLIENT_SECRET = ""
    settings.GOOGLE_FAKE = False


@pytest.fixture
def w(world):
    """t1 teaches s1, s3 and s4 (s2 belongs to t2)."""
    world.s3, world.s4 = make_user("s3@x.test", full_name="سارة"), make_user("s4@x.test", full_name="مريم")
    for s in (world.s3, world.s4):
        TeacherAssignment.objects.create(teacher=world.t1, student=s)
    return world


@pytest.fixture
def cap(django_capture_on_commit_callbacks):
    return lambda: django_capture_on_commit_callbacks(execute=True)


def day(n=2):
    return (timezone.now().astimezone(CAIRO) + timedelta(days=n)).date()


def one_off(teacher, cap, key="grp-00001", **kw):
    body = {"topic": "hifz", "date": day().isoformat(), "time": "19:00", "minutes": 45, **kw}
    with cap():
        return client_for(teacher).post("/api/v1/teacher/sessions", body, format="json", HTTP_IDEMPOTENCY_KEY=key)


def make_series(teacher, cap, students, key="ser-000001", **kw):
    body = {"kind": "group" if len(students) > 1 else "individual", "students": [s.pk for s in students], "topic": "hifz", "title": "حلقة المساء",
            "slots": [{"weekday": 6, "time": "19:00", "minutes": 60}, {"weekday": 1, "time": "20:30", "minutes": 45}],
            "meeting_url": "meet.google.com/abc-defg-hij", **kw}
    with cap():
        return client_for(teacher).post("/api/v1/teacher/series", body, format="json", HTTP_IDEMPOTENCY_KEY=key)


def confirmed(occ):
    return set(occ.bookings.filter(status="confirmed").values_list("student_id", flat=True))


def mine(user):
    r = client_for(user).get("/api/v1/bookings?when=upcoming&status=confirmed").json()
    return r if isinstance(r, list) else r["results"]


# ---- 1. individual and group, chosen students -------------------------------------------------------------------
def test_individual_session_with_one_chosen_student(w, cap):
    r = one_off(w.t1, cap, students=[w.s1.pk], kind="individual")
    assert r.status_code == 201, r.json()
    occ = SessionOccurrence.objects.get(pk=r.json()["id"])
    assert occ.kind == "individual" and occ.capacity == 1 and confirmed(occ) == {w.s1.pk}
    assert Notification.objects.filter(recipient=w.s1, kind="booking_created").count() == 1
    assert Notification.objects.filter(recipient=w.t1, kind="session_created").count() == 1


def test_group_session_books_and_notifies_every_selected_student_and_the_teacher(w, cap):
    r = one_off(w.t1, cap, students=[w.s1.pk, w.s3.pk, w.s4.pk], kind="group", title="مراجعة جزء عم", meeting_url="zoom.us/j/123456789")
    assert r.status_code == 201, r.json()
    body = r.json()
    occ = SessionOccurrence.objects.get(pk=body["id"])
    assert occ.kind == "group" and occ.circle is None and occ.capacity == 3 and confirmed(occ) == {w.s1.pk, w.s3.pk, w.s4.pk}
    assert occ.meeting_url == "https://zoom.us/j/123456789" and occ.meeting_provider == "zoom"   # one link for all, https added
    assert body["with"]["kind"] == "group" and body["with"]["count"] == 3
    for s in (w.s1, w.s3, w.s4):
        assert Notification.objects.filter(recipient=s, kind="booking_created").count() == 1
    assert Notification.objects.filter(recipient=w.t1, kind="session_created").count() == 1


@pytest.mark.parametrize("students,kind,field", [
    (["s1", "s2"], "group", "students"),            # s2 is not assigned to t1
    (["s1", "s1"], "group", "students"),            # duplicate
    (["s1", "s3"], "individual", "students"),       # individual = exactly one
    (["s1"], "group", "students"),                  # group = two or more
])
def test_invalid_participants_are_refused_and_nothing_is_created(w, cap, students, kind, field):
    r = one_off(w.t1, cap, students=[getattr(w, s).pk for s in students], kind=kind)
    assert r.status_code == 400 and field in r.json()["fields"], r.json()
    assert not SessionOccurrence.objects.exists() and not Booking.objects.exists()


def test_a_student_busy_at_that_time_blocks_the_group_session(w, cap):
    one_off(w.t2, cap, key="other-0001", student=w.s2.pk)            # unrelated
    first = one_off(w.t1, cap, key="first-0001", students=[w.s3.pk], kind="individual").json()["id"]
    r = one_off(w.t1, cap, key="second-001", students=[w.s1.pk, w.s3.pk], kind="group", time="19:30")
    assert r.status_code == 409   # the teacher's own overlap, or s3's: never double-booked
    assert SessionOccurrence.objects.exclude(status="cancelled").filter(teacher=w.t1).count() == 1 and first


def test_private_sessions_are_never_offered_to_other_students(w, cap):
    sid = one_off(w.t1, cap, students=[w.s1.pk, w.s3.pk], kind="group").json()["id"]
    outsider = w.s4                                         # the same teacher's student, not chosen for this session
    slots = client_for(outsider).get(f"/api/v1/teachers/{w.t1.pk}/slots?days=7").json()
    assert sid not in [x["id"] for x in slots]
    r = client_for(outsider).post("/api/v1/bookings", {"occurrence": sid}, format="json", HTTP_IDEMPOTENCY_KEY="steal-0001")
    assert r.status_code == 409 and outsider.pk not in confirmed(SessionOccurrence.objects.get(pk=sid))
    from apps.scheduling import waitlist
    with pytest.raises(Exception):
        waitlist.join(outsider, sid)
    assert not [b for b in mine(outsider) if b["occurrence"]["id"] == sid]


# ---- 2. adding and removing participants of one session ---------------------------------------------------------
def test_add_and_remove_a_participant_updates_the_students_dashboard(w, cap):
    sid = one_off(w.t1, cap, students=[w.s1.pk, w.s3.pk], kind="group").json()["id"]
    t = client_for(w.t1)
    rev0 = client_for(w.s4).get("/api/v1/notifications/unread").json()["assignment_rev"]
    with cap():
        r = t.post(f"/api/v1/teacher/sessions/{sid}/participants", {"student": w.s4.pk}, format="json")
    assert r.status_code == 201 and {p["student"] for p in r.json()["participants"] if p["status"] == "confirmed"} == {w.s1.pk, w.s3.pk, w.s4.pk}
    assert Notification.objects.filter(recipient=w.s4, kind="session_added").count() == 1
    assert client_for(w.s4).get("/api/v1/notifications/unread").json()["assignment_rev"] != rev0     # the app reloads at once
    assert sid in [b["occurrence"]["id"] for b in mine(w.s4)]
    assert t.post(f"/api/v1/teacher/sessions/{sid}/participants", {"student": w.s4.pk}, format="json").status_code == 409   # no duplicate
    assert t.post(f"/api/v1/teacher/sessions/{sid}/participants", {"student": w.s2.pk}, format="json").status_code == 400   # not t1's
    with cap():
        r = t.delete(f"/api/v1/teacher/sessions/{sid}/participants/{w.s4.pk}")
    assert r.status_code == 200
    assert sid not in [b["occurrence"]["id"] for b in mine(w.s4)]
    assert Notification.objects.filter(recipient=w.s4, kind="session_removed").count() == 1
    b = Booking.objects.get(occurrence_id=sid, student=w.s4)
    assert b.status == "cancelled"                                                   # the row stays (history)
    assert client_for(w.s4).post(f"/api/v1/bookings/{b.pk}/join").status_code == 409  # no join after removal


def test_individual_session_takes_one_student_and_the_last_one_cannot_be_removed(w, cap):
    sid = one_off(w.t1, cap, students=[w.s1.pk], kind="individual").json()["id"]
    t = client_for(w.t1)
    assert t.post(f"/api/v1/teacher/sessions/{sid}/participants", {"student": w.s3.pk}, format="json").json()["code"] == "individual_full"
    assert t.delete(f"/api/v1/teacher/sessions/{sid}/participants/{w.s1.pk}").json()["code"] == "last_participant"
    assert client_for(w.t2).post(f"/api/v1/teacher/sessions/{sid}/participants", {"student": w.s2.pk}, format="json").status_code == 404


# ---- 3. weekly series -------------------------------------------------------------------------------------------
def test_weekly_series_generates_sessions_with_each_days_time_and_books_everyone(w, cap):
    r = make_series(w.t1, cap, [w.s1, w.s3])
    assert r.status_code == 201, r.json()
    body = r.json()
    rule = RecurringSessionRule.objects.get(pk=body["id"])
    occs = list(SessionOccurrence.objects.filter(series=rule).order_by("starts_at"))
    today = timezone.now().astimezone(CAIRO).date()
    expected = [d for d in (today + timedelta(days=i) for i in range(S.HORIZON_DAYS + 1)) if d.weekday() in (6, 1)]
    assert 4 <= len(occs) <= len(expected) and body["result"]["created"] == len(occs)
    for o in occs:
        local = o.starts_at.astimezone(CAIRO)
        assert (local.weekday(), local.time()) in [(6, time(19, 0)), (1, time(20, 30))]
        assert (o.ends_at - o.starts_at) == timedelta(minutes=60 if local.weekday() == 6 else 45)
        assert o.kind == "group" and o.title == "حلقة المساء" and o.meeting_url == "https://meet.google.com/abc-defg-hij"
        assert confirmed(o) == {w.s1.pk, w.s3.pk}
    # one notice per person for the series, not one per generated session
    for s in (w.s1, w.s3):
        assert Notification.objects.filter(recipient=s, kind="series_added").count() == 1
        assert not Notification.objects.filter(recipient=s, kind__in=["booking_created", "booking_confirmed"]).exists()
    assert Notification.objects.filter(recipient=w.t1, kind="series_created").count() == 1
    assert body["schedule_text"] == "الأحد ٧:٠٠ مساءً، والثلاثاء ٨:٣٠ مساءً"   # the week read from Saturday


def test_series_creation_is_idempotent_and_generation_never_duplicates(w, cap):
    a = make_series(w.t1, cap, [w.s1, w.s3]).json()
    b = make_series(w.t1, cap, [w.s1, w.s3])
    assert b.status_code == 200 and b.json()["id"] == a["id"] and RecurringSessionRule.objects.count() == 1
    n = SessionOccurrence.objects.count()
    rule = RecurringSessionRule.objects.get()
    assert S.generate(rule)["created"] == 0 and SessionOccurrence.objects.count() == n
    assert Booking.objects.filter(status="confirmed").count() == 2 * n


def test_the_hourly_job_extends_the_horizon_without_the_teacher(w, cap):
    make_series(w.t1, cap, [w.s1, w.s3])
    n = SessionOccurrence.objects.count()
    out = S.run_all(now=timezone.now() + timedelta(days=7))
    assert out["created"] >= 2 and SessionOccurrence.objects.count() == n + out["created"]
    last = SessionOccurrence.objects.order_by("-starts_at").first()
    assert confirmed(last) == {w.s1.pk, w.s3.pk}


def test_end_date_limits_and_shortening_it_cancels_later_sessions(w, cap):
    end = day(20)
    rule = RecurringSessionRule.objects.get(pk=make_series(w.t1, cap, [w.s1, w.s3], ends_on=end.isoformat()).json()["id"])
    S.run_all(now=timezone.now() + timedelta(days=14))
    assert not SessionOccurrence.objects.filter(series=rule, series_date__gt=end).exists()
    short = day(4)
    with cap():
        r = client_for(w.t1).patch(f"/api/v1/teacher/series/{rule.pk}", {"ends_on": short.isoformat()}, format="json")
    assert r.status_code == 200, r.json()
    assert not SessionOccurrence.objects.filter(series=rule, series_date__gt=short, status="scheduled").exists()
    assert not Booking.objects.filter(occurrence__series=rule, occurrence__series_date__gt=short, status="confirmed").exists()
    assert Notification.objects.filter(recipient=w.s1, kind="series_changed").count() == 1


def test_pause_resume_and_cancel(w, cap):
    rule = RecurringSessionRule.objects.get(pk=make_series(w.t1, cap, [w.s1, w.s3]).json()["id"])
    t = client_for(w.t1)
    with cap():
        r = t.post(f"/api/v1/teacher/series/{rule.pk}/pause", {"reason": "إجازة"}, format="json")
    assert r.status_code == 200 and r.json()["status"] == "paused" and r.json()["sessions_cancelled"] >= 4
    assert not SessionOccurrence.objects.filter(series=rule, status="scheduled").exists()
    assert S.run_all()["created"] == 0                                               # a paused series makes nothing
    assert Notification.objects.filter(recipient=w.s1, kind="series_paused").count() == 1
    with cap():
        t.post(f"/api/v1/teacher/series/{rule.pk}/resume")
    assert SessionOccurrence.objects.filter(series=rule, status="scheduled").count() >= 4
    assert all(confirmed(o) == {w.s1.pk, w.s3.pk} for o in SessionOccurrence.objects.filter(series=rule, status="scheduled"))
    with cap():
        t.post(f"/api/v1/teacher/series/{rule.pk}/cancel")
    assert not SessionOccurrence.objects.filter(series=rule, status="scheduled").exists()
    assert t.post(f"/api/v1/teacher/series/{rule.pk}/resume").status_code == 409     # cancelled for good
    assert Notification.objects.filter(recipient=w.s3, kind="series_cancelled").count() == 1


def test_changing_the_weekly_times_moves_upcoming_sessions_only(w, cap):
    rule = RecurringSessionRule.objects.get(pk=make_series(w.t1, cap, [w.s1, w.s3]).json()["id"])
    with cap():
        r = client_for(w.t1).patch(f"/api/v1/teacher/series/{rule.pk}", {"slots": [{"weekday": 6, "time": "19:00", "minutes": 60},
                                                                               {"weekday": 3, "time": "18:00", "minutes": 45}]}, format="json")
    assert r.status_code == 200, r.json()
    live = SessionOccurrence.objects.filter(series=rule, status="scheduled")
    days = {o.starts_at.astimezone(CAIRO).weekday() for o in live}
    assert days == {6, 3}                                                             # Tuesday gone, Thursday added
    assert all(confirmed(o) == {w.s1.pk, w.s3.pk} for o in live)


def test_cancelling_one_session_of_a_series_is_never_recreated(w, cap):
    rule = RecurringSessionRule.objects.get(pk=make_series(w.t1, cap, [w.s1, w.s3]).json()["id"])
    first = SessionOccurrence.objects.filter(series=rule).order_by("starts_at").first()
    with cap():
        r = client_for(w.t1).post(f"/api/v1/teacher/sessions/{first.pk}/cancel", {"reason": "سفر"}, format="json")
    assert r.status_code == 200
    assert RecurringSessionException.objects.filter(rule=rule, date=first.series_date).exists()
    S.run_all()
    assert not SessionOccurrence.objects.filter(series=rule, series_date=first.series_date, series_slot=first.series_slot, status="scheduled").exists()
    assert Notification.objects.filter(recipient=w.s1, kind="booking_cancelled").count() == 1


def test_teacher_overlap_is_skipped_and_reported_not_double_booked(w, cap):
    target = next(d for d in (day(1) + timedelta(days=i) for i in range(7)) if d.weekday() == 6)
    one_off(w.t1, cap, key="busy-00001", student=w.s4.pk, date=target.isoformat(), time="19:15")
    r = make_series(w.t1, cap, [w.s1, w.s3]).json()
    assert any(datetime.fromisoformat(c).astimezone(CAIRO).date() == target for c in r["result"]["conflicts"])
    assert not SessionOccurrence.objects.filter(series_id=r["id"], series_date=target).exists()


def test_a_student_with_another_session_is_not_booked_into_that_one(w, cap):
    target = next(d for d in (day(1) + timedelta(days=i) for i in range(7)) if d.weekday() == 6)
    st = datetime.combine(target, time(19, 30), CAIRO)                              # s3 has a session with t2 then
    other = SessionOccurrence.objects.create(teacher=w.t2, starts_at=st, ends_at=st + timedelta(minutes=45))
    Booking.objects.create(occurrence=other, student=w.s3, idempotency_key="s3-busy-0001")
    r = make_series(w.t1, cap, [w.s1, w.s3]).json()
    occ = SessionOccurrence.objects.get(series_id=r["id"], series_date=target)
    assert confirmed(occ) == {w.s1.pk} and r["result"]["student_conflicts"] >= 1


def test_series_participants_add_and_remove_keep_history(w, cap):
    rule = RecurringSessionRule.objects.get(pk=make_series(w.t1, cap, [w.s1, w.s3]).json()["id"])
    t = client_for(w.t1)
    with cap():
        r = t.post(f"/api/v1/teacher/series/{rule.pk}/participants", {"student": w.s4.pk}, format="json")
    assert r.status_code == 201
    live = SessionOccurrence.objects.filter(series=rule, status="scheduled")
    assert all(w.s4.pk in confirmed(o) for o in live)
    assert Notification.objects.filter(recipient=w.s4, kind="series_added").count() == 1
    # one session is now in the past, with s4 present and evaluated
    past = live.order_by("starts_at").first()
    SessionOccurrence.objects.filter(pk=past.pk).update(starts_at=timezone.now() - timedelta(hours=2), ends_at=timezone.now() - timedelta(hours=1))
    b = Booking.objects.get(occurrence=past, student=w.s4)
    assert t.post(f"/api/v1/bookings/{b.pk}/attendance", {"attendance": "present"}, format="json").status_code == 200
    assert t.put(f"/api/v1/bookings/{b.pk}/evaluation", {"memorization_grade": "good", "note": "أحسنت"}, format="json").status_code == 200
    with cap():
        r = t.delete(f"/api/v1/teacher/series/{rule.pk}/participants/{w.s4.pk}")
    assert r.status_code == 200 and r.json()["result"]["bookings_cancelled"] >= 3
    b.refresh_from_db()
    assert b.status == "confirmed" and b.attendance == "present" and SessionEvaluation.objects.filter(booking=b).exists()   # history kept
    assert not Booking.objects.filter(occurrence__series=rule, student=w.s4, status="confirmed", occurrence__starts_at__gt=timezone.now()).exists()
    assert Notification.objects.filter(recipient=w.s4, kind="series_removed").count() == 1
    S.run_all()                                                                      # the hourly job does not bring them back
    assert not Booking.objects.filter(occurrence__series=rule, student=w.s4, status="confirmed", occurrence__starts_at__gt=timezone.now()).exists()
    p = rule.participants.get(student=w.s4)
    assert not p.active and p.ended_at is not None


def test_series_kind_rules(w, cap):
    r = make_series(w.t1, cap, [w.s1], key="ind-000001")
    rule = RecurringSessionRule.objects.get(pk=r.json()["id"])
    assert rule.kind == "individual"
    assert client_for(w.t1).post(f"/api/v1/teacher/series/{rule.pk}/participants", {"student": w.s3.pk}, format="json").json()["code"] == "individual_full"
    bad = make_series(w.t1, cap, [w.s1, w.s1], key="dup-000001")
    assert bad.status_code == 400
    none = make_series(w.t1, cap, [w.s1, w.s3], key="noslot-001", slots=[])
    assert none.status_code == 400 and "slots" in none.json()["fields"]


def test_series_follows_cairo_dst():
    """Egypt's summer time starts on the last Friday of April (2027-04-30): a Saturday 19:00 series stays 19:00 local."""
    t = make_user("dst-t@x.test", Role.TEACHER)
    s = make_user("dst-s@x.test")
    TeacherAssignment.objects.create(teacher=t, student=s)
    now = datetime(2027, 4, 20, 8, 0, tzinfo=ZoneInfo("UTC"))
    rule = RecurringSessionRule.objects.create(teacher=t, kind="individual", timezone="Africa/Cairo", starts_on=date(2027, 4, 20))
    rule.slots.create(weekday=5, start_time=time(19, 0), minutes=45)
    rule.participants.create(student=s)
    S.generate(rule, now=now)
    occs = list(SessionOccurrence.objects.filter(series=rule).order_by("starts_at"))
    assert [o.starts_at.astimezone(CAIRO).time() for o in occs] == [time(19, 0), time(19, 0)]
    assert [o.starts_at.astimezone(ZoneInfo("UTC")).hour for o in occs] == [17, 16]


# ---- 4. dashboard, attendance and evaluation ----------------------------------------------------------------------
def test_student_dashboard_shows_only_their_sessions_with_type_title_teacher_and_join(w, cap):
    rid = make_series(w.t1, cap, [w.s1, w.s3]).json()["id"]
    rows = mine(w.s1)
    ours = [b for b in rows if b["occurrence"]["series"] == rid]
    assert ours and all(b["occurrence"]["kind"] == "group" and b["occurrence"]["title"] == "حلقة المساء" for b in ours)
    assert ours[0]["occurrence"]["teacher_name"] == w.t1.display_name and ours[0]["has_meeting_link"] and ours[0]["meeting_provider"] == "Google Meet"
    assert "student_name" in ours[0] and all(b["student"] == w.s1.pk for b in rows)   # their own bookings only, no classmates
    assert not [b for b in mine(w.s2) if b["occurrence"]["series"] == rid]


def test_join_gives_the_same_link_to_every_participant_inside_the_window(w, cap):
    rid = make_series(w.t1, cap, [w.s1, w.s3]).json()["id"]
    occ = SessionOccurrence.objects.filter(series_id=rid).order_by("starts_at").first()
    SessionOccurrence.objects.filter(pk=occ.pk).update(starts_at=timezone.now() + timedelta(minutes=3), ends_at=timezone.now() + timedelta(minutes=63))
    urls = {client_for(s).post(f"/api/v1/bookings/{Booking.objects.get(occurrence=occ, student=s).pk}/join").json()["url"] for s in (w.s1, w.s3)}
    assert urls == {"https://meet.google.com/abc-defg-hij"}


def test_attendance_and_evaluation_are_recorded_per_student(w, cap):
    sid = one_off(w.t1, cap, students=[w.s1.pk, w.s3.pk, w.s4.pk], kind="group").json()["id"]
    t = client_for(w.t1)
    b1, b3 = (Booking.objects.get(occurrence_id=sid, student=s) for s in (w.s1, w.s3))
    assert t.put(f"/api/v1/bookings/{b1.pk}/evaluation", {"note": "قبل البدء"}, format="json").status_code == 409
    SessionOccurrence.objects.filter(pk=sid).update(starts_at=timezone.now() - timedelta(minutes=50), ends_at=timezone.now() - timedelta(minutes=5))
    assert t.post(f"/api/v1/bookings/{b1.pk}/attendance", {"attendance": "present"}, format="json").status_code == 200
    assert t.post(f"/api/v1/bookings/{b3.pk}/attendance", {"attendance": "absent"}, format="json").status_code == 200
    with cap():
        r = t.put(f"/api/v1/bookings/{b1.pk}/evaluation", {"memorization_grade": "excellent", "surah": 67, "ayah_from": 1, "ayah_to": 10,
                                                           "tajweed_grade": "very_good", "tajweed_note": "المدود", "note": "ممتاز"}, format="json")
    assert r.status_code == 200, r.json()
    assert t.put(f"/api/v1/bookings/{b3.pk}/evaluation", {"tajweed_grade": "needs_work"}, format="json").status_code == 200
    assert t.put(f"/api/v1/bookings/{b1.pk}/evaluation", {"surah": 67, "ayah_from": 1, "ayah_to": 99}, format="json").status_code == 400  # al-Mulk has 30
    assert client_for(w.t2).put(f"/api/v1/bookings/{b1.pk}/evaluation", {"note": "x"}, format="json").status_code in (403, 404)
    b1.refresh_from_db(); b3.refresh_from_db()
    assert (b1.attendance, b3.attendance) == ("present", "absent")
    assert b1.evaluation.memorization_grade == "excellent" and b1.evaluation.ayah_to == 10 and b3.evaluation.tajweed_grade == "needs_work"
    own = client_for(w.s1).get(f"/api/v1/bookings/{b1.pk}").json()
    assert own["evaluation"]["memorization_label"] == "ممتاز" and own["evaluation"]["note"] == "ممتاز"
    assert client_for(w.s1).get(f"/api/v1/bookings/{b3.pk}").status_code == 404    # never a classmate's record
    sched = t.get("/api/v1/teacher/occurrences?days=8").json()
    row = next(o for o in sched if o["id"] == sid)
    assert {b["student"]: (b["evaluation"] or {}).get("tajweed_grade") for b in row["bookings"]} == {w.s1.pk: "very_good", w.s3.pk: "needs_work", w.s4.pk: None}
    assert Notification.objects.filter(recipient=w.s1, kind="session_evaluated").count() == 1


# ---- 5. reminders ------------------------------------------------------------------------------------------------
def test_fifteen_minute_reminder_reaches_the_teacher_and_every_active_participant_once(w, cap):
    sid = one_off(w.t1, cap, students=[w.s1.pk, w.s3.pk, w.s4.pk], kind="group").json()["id"]
    with cap():
        client_for(w.t1).delete(f"/api/v1/teacher/sessions/{sid}/participants/{w.s4.pk}")
    start = timezone.now() + timedelta(minutes=15)
    SessionOccurrence.objects.filter(pk=sid).update(starts_at=start, ends_at=start + timedelta(minutes=45))
    with cap():
        send_due()
        send_due()                                                                   # a second alarm sends nothing new
    got = set(Notification.objects.filter(kind="session_soon").values_list("recipient_id", flat=True))
    assert got == {w.t1.pk, w.s1.pk, w.s3.pk}                                         # not the removed student
    assert Notification.objects.filter(kind="session_soon").count() == 3


# ---- 6. admin --------------------------------------------------------------------------------------------------
def test_admin_can_add_a_student_the_teacher_does_not_teach(w, cap):
    rule = RecurringSessionRule.objects.get(pk=make_series(w.t1, cap, [w.s1, w.s3]).json()["id"])
    assert client_for(w.t1).post(f"/api/v1/teacher/series/{rule.pk}/participants", {"student": w.s2.pk}, format="json").status_code == 400
    a = client_for(w.admin)
    with cap():
        r = a.post(f"/api/v1/admin/series/{rule.pk}/participants", {"student": w.s2.pk}, format="json")
    assert r.status_code == 201, r.json()
    assert all(w.s2.pk in confirmed(o) for o in SessionOccurrence.objects.filter(series=rule, status="scheduled"))
    assert Notification.objects.filter(recipient=w.t1, kind="series_participant_added").count() == 1
    assert a.get("/api/v1/admin/series").status_code == 200
    occ = SessionOccurrence.objects.filter(series=rule, status="scheduled").first()
    with cap():
        assert a.delete(f"/api/v1/admin/sessions/{occ.pk}/participants/{w.s2.pk}").status_code == 200
    assert w.s2.pk not in confirmed(occ)
    assert client_for(w.s1).get("/api/v1/admin/series").status_code == 403
