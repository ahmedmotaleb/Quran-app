"""Google Calendar + Meet for teacher-created sessions. Google is replaced by a recording fake at the single network
call (google._send), so every request HALQA would make is checked: payload, query params, retries and ids."""
import json
from datetime import date, timedelta
from zoneinfo import ZoneInfo

import pytest
from django.core import signing
from django.utils import timezone

from apps.accounts.models import AccountStatus, Role
from apps.core.models import AuditEvent
from apps.integrations import crypto, fake, google, sync
from apps.integrations.models import GoogleCalendarConnection, GoogleEvent
from apps.notifications.models import Notification
from apps.scheduling.models import Booking, Circle, CircleMember, SessionOccurrence

from .conftest import client_for, make_user

pytestmark = pytest.mark.django_db
CAIRO = ZoneInfo("Africa/Cairo")


class Google:
    """Records every call; `fail` queues (match, status, body) answers that override the fake once each."""

    def __init__(self):
        self.calls, self.fail = [], []

    def __call__(self, method, url, *, params=None, data=None, json=None, headers=None):
        self.calls.append({"method": method, "url": url, "params": params or {}, "data": data or {}, "json": json or {}, "headers": headers or {}})
        for i, (match, status, body) in enumerate(self.fail):
            if match(method, url, data or {}):
                self.fail.pop(i)
                return status, body
        return fake.handle(method, url, params=params, data=data, json=json, headers=headers)

    def events(self, method):
        return [c for c in self.calls if c["method"] == method and "/calendar/v3/" in c["url"]]


@pytest.fixture
def g(settings, monkeypatch):
    settings.GOOGLE_CLIENT_ID, settings.GOOGLE_CLIENT_SECRET = "client-id", "client-secret"
    settings.GOOGLE_REDIRECT_URI = "https://halqa.test/api/v1/integrations/google/callback"
    settings.GOOGLE_FAKE = False
    from django.core.cache import cache

    cache.delete(fake.KEY)
    rec = Google()
    monkeypatch.setattr(google, "_send", rec)
    monkeypatch.setattr(sync.time, "sleep", lambda s: None)
    return rec


def connect(teacher, status=GoogleCalendarConnection.Status.ACTIVE):
    return GoogleCalendarConnection.objects.create(teacher=teacher, google_account_email="teacher.cal@gmail.com",
                                                   encrypted_refresh_token=crypto.encrypt("refresh-SECRET-123"),
                                                   scopes=google.CALENDAR_SCOPE, status=status, connected_at=timezone.now())


def when(days=2, hour=19):
    d = (timezone.now().astimezone(CAIRO) + timedelta(days=days)).date()
    return {"date": d.isoformat(), "time": f"{hour:02d}:00"}


def create(teacher, key="req-0001", **kw):
    body = {"student": kw.pop("student", None), "circle": kw.pop("circle", None), "topic": "hifz", "minutes": 45, **when(), **kw}
    return client_for(teacher).post("/api/v1/teacher/sessions", body, format="json", HTTP_IDEMPOTENCY_KEY=key)


# 1 -----------------------------------------------------------------------------------------------------------------
def test_teacher_without_google_cannot_create(world, g):
    r = create(world.t1, student=world.s1.pk)
    assert r.status_code == 409 and r.json()["code"] == "google_not_connected"
    assert not SessionOccurrence.objects.filter(teacher=world.t1).exists() and not g.calls


# 2 -----------------------------------------------------------------------------------------------------------------
def test_oauth_state_is_signed_single_use_and_bound_to_the_teacher(world, g):
    c = client_for(world.t1)
    url = c.post("/api/v1/teacher/integrations/google/connect").json()["auth_url"]
    assert url.startswith(google.AUTH_URL) and "calendar.events" in url and "access_type=offline" in url
    assert "include_granted_scopes=true" in url and "client-secret" not in url
    state = url.split("state=")[1].split("&")[0]
    from urllib.parse import unquote

    state = unquote(state)
    cb = "/api/v1/integrations/google/callback"
    # Forged and wrong-account states are refused; nothing is stored.
    assert "invalid_state" in client_for(world.t1).get(cb, {"state": "forged", "code": "c"})["Location"]
    other = signing.dumps({"t": world.t1.pk, "n": "not-issued"}, salt="halqa.google.oauth")
    assert "invalid_state" in client_for(world.t1).get(cb, {"state": other, "code": "c"})["Location"]
    from rest_framework.test import APIClient

    assert "wrong_account" in APIClient().get(cb, {"state": state, "code": "c"})["Location"]  # not signed in
    # The state was consumed by that attempt: even the right teacher cannot reuse it.
    assert "invalid_state" in client_for(world.t1).get(cb, {"state": state, "code": "c"})["Location"]
    state = unquote(c.post("/api/v1/teacher/integrations/google/connect").json()["auth_url"].split("state=")[1].split("&")[0])
    assert "wrong_account" in client_for(world.t2).get(cb, {"state": state, "code": "c"})["Location"]
    state = unquote(c.post("/api/v1/teacher/integrations/google/connect").json()["auth_url"].split("state=")[1].split("&")[0])
    r = client_for(world.t1).get(cb, {"state": state, "code": "auth-CODE-xyz"})
    assert r.status_code == 302 and r["Location"].endswith("#/google?result=connected")
    conn = GoogleCalendarConnection.objects.get(teacher=world.t1)
    assert conn.status == "active" and conn.google_account_email == "teacher.calendar@example.com"
    st = c.get("/api/v1/teacher/integrations/google/status").json()
    assert st["status"] == "active" and st["email"] == "te" + "•" * 14 + "@example.com"
    assert client_for(world.s1).post("/api/v1/teacher/integrations/google/connect").status_code == 403


# 3 -----------------------------------------------------------------------------------------------------------------
def test_refresh_token_encrypted_and_never_exposed(world, g, caplog):
    conn = connect(world.t1)
    assert "refresh-SECRET-123" not in conn.encrypted_refresh_token and crypto.decrypt(conn.encrypted_refresh_token) == "refresh-SECRET-123"
    assert crypto.decrypt("garbage") is None
    create(world.t1, student=world.s1.pk)
    out = json.dumps(client_for(world.t1).get("/api/v1/teacher/integrations/google/status").json())
    out += json.dumps(client_for(world.t1).get("/api/v1/teacher/occurrences?days=7").json())
    audit = json.dumps(list(AuditEvent.objects.values_list("data", flat=True)))
    for secret in ("refresh-SECRET-123", "fake-access", "Bearer"):
        assert secret not in out and secret not in audit and secret not in caplog.text


# 4–9 ---------------------------------------------------------------------------------------------------------------
def test_create_event_with_meet_and_student_invite(world, g, django_capture_on_commit_callbacks):
    connect(world.t1)
    with django_capture_on_commit_callbacks(execute=True):
        r = create(world.t1, student=world.s1.pk, prep_note="ملاحظة خاصة للتحضير", title="سورة الملك")
    assert r.status_code == 201, r.json()
    ins = g.events("POST")
    assert len(ins) == 1
    call = ins[0]
    assert call["url"].endswith("/calendars/primary/events")
    assert call["params"] == {"conferenceDataVersion": 1, "sendUpdates": "all"}
    body = call["json"]
    ev = GoogleEvent.objects.get()
    assert body["conferenceData"]["createRequest"] == {"requestId": str(ev.request_id), "conferenceSolutionKey": {"type": "hangoutsMeet"}}
    assert body["id"] == ev.event_id and body["attendees"] == [{"email": world.s1.email}]
    assert body["summary"].startswith("HALQA — جلسة حفظ — ") and "ملاحظة خاصة" not in json.dumps(body, ensure_ascii=False)
    assert body["start"]["timeZone"] == "Africa/Cairo" and body["start"]["dateTime"].endswith("+02:00") or body["start"]["dateTime"].endswith("+03:00")
    occ = SessionOccurrence.objects.get()
    assert occ.status == "scheduled" and occ.meeting_provider == "google_meet"
    assert occ.meeting_url == ev.meet_url and ev.meet_url.startswith("https://meet.google.com/")  # as returned by Google
    assert ev.sync_status == "ready" and ev.conference_id and ev.html_link
    assert Booking.objects.filter(occurrence=occ, student=world.s1, status="confirmed").exists()
    n = Notification.objects.get(recipient=world.s1, kind="booking_created")
    assert n.title == "تم حجز جلسة حفظ" and n.body.startswith("يوم ") and "meet.google" not in n.body
    from apps.notifications.push import payload_for

    assert "meet.google" not in json.dumps(payload_for("booking_created", "/sessions"))
    # Unique conference request id per event.
    create(world.t1, key="req-0002", student=world.s1.pk, **when(days=3))
    ids = [c["json"]["conferenceData"]["createRequest"]["requestId"] for c in g.events("POST")]
    assert len(set(ids)) == 2


def test_conference_created_asynchronously_is_polled(world, g, monkeypatch):
    """Google answers the insert before the Meet is ready (createRequest pending); HALQA reads the event again."""
    connect(world.t1)
    real = fake.handle

    def slow_meet(method, url, **kw):
        status, body = real(method, url, **kw)
        if method == "POST":
            body = {**body, "conferenceData": {"createRequest": {"status": {"statusCode": "pending"}}}}
        return status, body

    monkeypatch.setattr(fake, "handle", slow_meet)
    r = create(world.t1, student=world.s1.pk)
    assert r.status_code == 201 and GoogleEvent.objects.get().meet_url.startswith("https://meet.google.com/")
    assert len(g.events("GET")) == 1 and len(g.events("POST")) == 1


def test_meet_still_pending_keeps_session_hidden_then_job_finishes(world, g, monkeypatch):
    connect(world.t1)
    real = fake.handle
    state = {"ready": False}

    def never_ready(method, url, **kw):
        status, body = real(method, url, **kw)
        if not state["ready"] and method in ("POST", "GET"):
            body = {**body, "conferenceData": {"createRequest": {"status": {"statusCode": "pending"}}}}
        return status, body

    monkeypatch.setattr(fake, "handle", never_ready)
    r = create(world.t1, student=world.s1.pk)
    assert r.status_code == 202 and r.json()["status"] == "pending" and not Booking.objects.exists()
    state["ready"] = True
    sync.run_due()
    assert SessionOccurrence.objects.get().status == "scheduled" and Booking.objects.count() == 1


# 10 ----------------------------------------------------------------------------------------------------------------
def test_reschedule_updates_the_same_event(world, g, django_capture_on_commit_callbacks):
    connect(world.t1)
    occ_id = create(world.t1, student=world.s1.pk).json()["id"]
    ev = GoogleEvent.objects.get()
    new = when(days=4, hour=17)
    with django_capture_on_commit_callbacks(execute=True):
        r = client_for(world.t1).patch(f"/api/v1/teacher/sessions/{occ_id}", new, format="json")
    assert r.status_code == 200
    patches = g.events("PATCH")
    assert len(patches) == 1 and patches[0]["url"].endswith(f"/events/{ev.event_id}")
    assert patches[0]["params"] == {"conferenceDataVersion": 1, "sendUpdates": "all"}
    assert "conferenceData" not in patches[0]["json"] and patches[0]["json"]["start"]["dateTime"].startswith(new["date"])
    assert len(g.events("POST")) == 1  # no second event
    occ = SessionOccurrence.objects.get(pk=occ_id)
    assert occ.starts_at.astimezone(CAIRO).hour == 17
    assert AuditEvent.objects.filter(action="session.google_rescheduled").exists()
    assert Notification.objects.filter(recipient=world.s1, kind="booking_rescheduled").exists()
    # Google refuses → HALQA unchanged.
    g.fail.append((lambda m, u, d: m == "PATCH", 403, {"error": {"errors": [{"reason": "forbidden"}]}}))
    r = client_for(world.t1).patch(f"/api/v1/teacher/sessions/{occ_id}", when(days=5, hour=10), format="json")
    assert r.status_code == 502 and r.json()["code"] == "google_forbidden"
    assert SessionOccurrence.objects.get(pk=occ_id).starts_at == occ.starts_at


# 11 ----------------------------------------------------------------------------------------------------------------
def test_cancellation_cancels_the_same_event(world, g, django_capture_on_commit_callbacks):
    connect(world.t1)
    occ_id = create(world.t1, student=world.s1.pk).json()["id"]
    ev = GoogleEvent.objects.get()
    with django_capture_on_commit_callbacks(execute=True):
        r = client_for(world.t1).post(f"/api/v1/teacher/sessions/{occ_id}/cancel", {"reason": "ظرف طارئ"}, format="json")
    assert r.status_code == 200
    d = g.events("DELETE")
    assert len(d) == 1 and d[0]["url"].endswith(f"/events/{ev.event_id}") and d[0]["params"] == {"sendUpdates": "all"}
    ev.refresh_from_db()
    occ = SessionOccurrence.objects.get(pk=occ_id)
    assert ev.sync_status == "cancelled" and occ.status == "cancelled"
    assert Booking.objects.get(occurrence=occ).status == "cancelled"  # kept, cancelled (history)
    assert AuditEvent.objects.filter(action="session.google_cancelled").exists()


def test_cancel_while_google_down_is_retried_by_the_job(world, g, django_capture_on_commit_callbacks):
    connect(world.t1)
    occ_id = create(world.t1, student=world.s1.pk).json()["id"]
    g.fail.append((lambda m, u, d: m == "DELETE", 503, {}))
    with django_capture_on_commit_callbacks(execute=True):
        client_for(world.t1).post(f"/api/v1/teacher/sessions/{occ_id}/cancel", format="json")
    ev = GoogleEvent.objects.get()
    assert ev.cancel_pending and SessionOccurrence.objects.get(pk=occ_id).status == "cancelled"
    sync.run_due()
    ev.refresh_from_db()
    assert not ev.cancel_pending and ev.sync_status == "cancelled"


# 12–13 -----------------------------------------------------------------------------------------------------------
def test_revoked_refresh_token_needs_reconnect(world, g):
    connect(world.t1)
    g.fail.append((lambda m, u, d: u.endswith("/token"), 400, {"error": "invalid_grant"}))
    r = create(world.t1, student=world.s1.pk)
    assert r.status_code == 409 and r.json()["message"] == "يجب إعادة ربط Google Calendar قبل إنشاء الجلسة."
    assert GoogleCalendarConnection.objects.get().status == "reconnect_required"
    occ = SessionOccurrence.objects.get()
    assert occ.status == "pending" and not Booking.objects.filter(occurrence=occ).exists()  # student not told
    assert not Notification.objects.filter(recipient=world.s1).exists()
    assert create(world.t1, key="req-new-1", student=world.s1.pk, **when(days=6)).json()["code"] == "google_reconnect_required"
    st = client_for(world.t1).get("/api/v1/teacher/integrations/google/status").json()
    assert st["status"] == "reconnect_required"


def test_401_gets_a_fresh_token_and_retries_once(world, g):
    connect(world.t1)
    g.fail.append((lambda m, u, d: m == "POST" and u.endswith("/events"), 401, {}))
    assert create(world.t1, student=world.s1.pk).status_code == 201
    tokens = [c for c in g.calls if c["url"].endswith("/token")]
    assert len(tokens) == 2 and len(g.events("POST")) == 2 and GoogleEvent.objects.count() == 1


# 14–16 -----------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("status,code", [(403, "google_forbidden"), (429, "google_rate_limited"), (500, "google_unavailable"), (503, "google_unavailable")])
def test_google_errors_are_clean_and_retry_safe(world, g, status, code):
    connect(world.t1)
    g.fail.append((lambda m, u, d: m == "POST" and u.endswith("/events"), status, {"error": {"errors": [{"reason": "x"}], "message": "internal detail"}}))
    r = create(world.t1, student=world.s1.pk)
    assert r.status_code == 502 and r.json()["code"] == code and "internal detail" not in json.dumps(r.json())
    assert r.json()["message"] in (sync.GENERIC, sync.MESSAGES["forbidden"])
    occ = SessionOccurrence.objects.get()
    ev = GoogleEvent.objects.get()
    assert occ.status == "pending" and ev.sync_status == "failed" and not Booking.objects.exists()
    first_id, first_req = ev.event_id, ev.request_id
    # A retry (teacher «أعد المحاولة», a repeated submit, or the hourly job) reuses the same ids.
    sync.run_due()
    ev.refresh_from_db()
    assert ev.sync_status == "ready" and ev.event_id == first_id and ev.request_id == first_req
    assert all(c["json"]["id"] == first_id for c in g.events("POST"))


# 17 ----------------------------------------------------------------------------------------------------------------
def test_double_submit_and_lost_answer_never_duplicate(world, g):
    connect(world.t1)
    a = create(world.t1, key="same-key-1", student=world.s1.pk)
    b = create(world.t1, key="same-key-1", student=world.s1.pk)
    assert a.json()["id"] == b.json()["id"] and SessionOccurrence.objects.count() == 1 and len(g.events("POST")) == 1
    # The insert reached Google but the answer was lost: the retry gets 409 and reads the event instead.
    connect(world.t2)
    g.fail.append((lambda m, u, d: m == "POST" and u.endswith("/events"), 503, {}))
    real = google._send

    created = {}

    def lose_answer(method, url, **kw):
        if method == "POST" and url.endswith("/events") and not created:
            created["x"] = fake.handle(method, url, **kw)  # Google stored it ...
            return 503, {}  # ... but HALQA never saw the answer
        return real(method, url, **kw)

    g.fail.clear()
    google._send = lose_answer
    try:
        r = create(world.t2, key="key-t2-001", student=world.s2.pk)
        assert r.status_code == 502
        r = create(world.t2, key="key-t2-001", student=world.s2.pk)  # the app retries the same request
    finally:
        google._send = real
    assert r.status_code == 201 and GoogleEvent.objects.filter(teacher=world.t2).count() == 1
    assert len(fake._events()) == 2  # one event per session at "Google", never a copy
    from django.db import IntegrityError

    with pytest.raises(IntegrityError):
        GoogleEvent.objects.create(occurrence=SessionOccurrence.objects.filter(teacher=world.t2).first(), teacher=world.t2, creation_key="other")


# 18–19 -----------------------------------------------------------------------------------------------------------
def test_circle_attendees_are_active_members_only(world, g):
    connect(world.t1)
    circle = Circle.objects.create(name="حلقة الفجر", teacher=world.t1, capacity=5, state="published")
    s3, s4, s5 = make_user("s3@x.test"), make_user("s4@x.test"), make_user("s5@x.test")
    for s in (world.s1, s3, s4, s5):
        CircleMember.objects.create(circle=circle, student=s)
    CircleMember.objects.filter(student=s4).update(active=False)  # left the circle
    s5.status = AccountStatus.SUSPENDED
    s5.save()
    r = create(world.t1, circle=circle.pk, topic="review")
    assert r.status_code == 201, r.json()
    body = g.events("POST")[0]["json"]
    assert sorted(a["email"] for a in body["attendees"]) == sorted([world.s1.email, s3.email])
    assert body["guestsCanSeeOtherGuests"] is False
    occ = SessionOccurrence.objects.get()
    assert occ.kind == "group" and occ.circle == circle
    assert set(occ.bookings.filter(status="confirmed").values_list("student_id", flat=True)) == {world.s1.pk, s3.pk}
    # A member joins before the session: the hourly job updates the same event's invite list.
    s6 = make_user("s6@x.test")
    CircleMember.objects.create(circle=circle, student=s6)
    sync.run_due()
    assert any(s6.email in json.dumps(p["json"]) for p in g.events("PATCH"))


def test_deleted_or_suspended_student_is_not_invited(world, g):
    connect(world.t1)
    world.s1.status = AccountStatus.SUSPENDED
    world.s1.save()
    r = create(world.t1, student=world.s1.pk)
    assert r.status_code == 400 and not g.events("POST")


# 20–21 -----------------------------------------------------------------------------------------------------------
def test_meet_url_only_inside_join_window_and_only_for_the_booked_student(world, g, settings):
    connect(world.t1)
    occ_id = create(world.t1, student=world.s1.pk).json()["id"]
    b = Booking.objects.get(occurrence_id=occ_id)
    r = client_for(world.s1).post(f"/api/v1/bookings/{b.pk}/join")
    assert r.status_code == 409 and r.json()["code"] == "too_early" and "meet.google" not in json.dumps(r.json())
    rows = client_for(world.s1).get("/api/v1/bookings").json()
    assert "meet.google" not in json.dumps(rows)  # the list never carries the link
    occ = SessionOccurrence.objects.get(pk=occ_id)
    occ.starts_at, occ.ends_at = timezone.now() + timedelta(minutes=5), timezone.now() + timedelta(minutes=50)
    occ.save()
    r = client_for(world.s1).post(f"/api/v1/bookings/{b.pk}/join")
    assert r.status_code == 200 and r.json()["url"] == GoogleEvent.objects.get().meet_url
    assert client_for(world.s2).post(f"/api/v1/bookings/{b.pk}/join").status_code == 404
    assert client_for(world.p1).post(f"/api/v1/bookings/{b.pk}/join").status_code == 403
    assert client_for(world.t2).get(f"/api/v1/teacher/sessions/{occ_id}").status_code == 404


def test_pending_session_is_invisible_to_students_and_slots(world, g):
    connect(world.t1)
    g.fail.append((lambda m, u, d: m == "POST" and u.endswith("/events"), 503, {}))
    create(world.t1, student=world.s1.pk)
    assert client_for(world.s1).get("/api/v1/bookings").json() in ([], {"count": 0, "next": None, "previous": None, "results": []}) or \
        not client_for(world.s1).get("/api/v1/bookings").json().get("results")
    slots = client_for(world.s1).get(f"/api/v1/teachers/{world.t1.pk}/slots").json()
    assert SessionOccurrence.objects.get().pk not in [s["id"] for s in (slots.get("results") if isinstance(slots, dict) else slots)]


def test_pasted_link_cannot_replace_google_meet(world, g):
    connect(world.t1)
    occ_id = create(world.t1, student=world.s1.pk).json()["id"]
    r = client_for(world.t1).put(f"/api/v1/teacher/occurrences/{occ_id}/meeting", {"url": "https://meet.google.com/abc-defg-hij"}, format="json")
    assert r.status_code == 409 and r.json()["code"] == "google_managed"


def test_disconnect_revokes_and_blocks_new_sessions_but_keeps_existing(world, g):
    connect(world.t1)
    occ_id = create(world.t1, student=world.s1.pk).json()["id"]
    r = client_for(world.t1).post("/api/v1/teacher/integrations/google/disconnect")
    assert r.json()["status"] == "not_connected" and any(c["url"].endswith("/revoke") for c in g.calls)
    conn = GoogleCalendarConnection.objects.get()
    assert conn.encrypted_refresh_token == "" and conn.revoked_at
    assert SessionOccurrence.objects.get(pk=occ_id).meeting_url  # existing link stays usable
    assert create(world.t1, key="after-disc-1", student=world.s1.pk, **when(days=5)).json()["code"] == "google_not_connected"


def test_admin_resync_and_view_without_tokens(world, g):
    connect(world.t1)
    g.fail.append((lambda m, u, d: m == "POST" and u.endswith("/events"), 503, {}))
    r = create(world.t1, student=world.s1.pk)
    occ_id = SessionOccurrence.objects.get().pk
    assert r.json()["fields"]["session"] == [str(occ_id)]  # the teacher's app can offer «أعد المحاولة» for it
    a = client_for(world.admin)
    v = a.get(f"/api/v1/admin/sessions/{occ_id}/google").json()
    assert v["sync_status"] == "failed" and "…" in v["event_id"] and "refresh" not in json.dumps(v)
    r = a.post(f"/api/v1/admin/sessions/{occ_id}/google")
    assert r.status_code == 200 and r.json()["sync_status"] == "ready" and r.json()["meet_ready"] is True
    assert AuditEvent.objects.filter(action="session.google_resynced").exists()
    # A working Meet is never replaced: resync on a ready event creates nothing.
    before = len(g.events("POST"))
    a.post(f"/api/v1/admin/sessions/{occ_id}/google")
    assert len(g.events("POST")) == before and not [p for p in g.events("PATCH") if "conferenceData" in p["json"]]


def test_admin_cancel_also_cancels_google(world, g, django_capture_on_commit_callbacks):
    connect(world.t1)
    occ_id = create(world.t1, student=world.s1.pk).json()["id"]
    with django_capture_on_commit_callbacks(execute=True):
        r = client_for(world.admin).post(f"/api/v1/admin/sessions/{occ_id}/cancel", {"reason": "إجازة المعلم"}, format="json")
    assert r.status_code == 200 and len(g.events("DELETE")) == 1


def test_date_must_be_in_the_future(world, g):
    connect(world.t1)
    past = (timezone.now().astimezone(CAIRO) - timedelta(days=1)).date()
    r = create(world.t1, student=world.s1.pk, date=past.isoformat())
    assert r.status_code == 400 and not g.events("POST")
    assert isinstance(date.today(), date)
