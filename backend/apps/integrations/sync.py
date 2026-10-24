"""One Google Calendar event (with its Google Meet) per HALQA session occurrence.

State machine (GoogleEvent.sync_status): pending → ready | failed | reconnect_required; ready/… → cancelled.
The occurrence stays PENDING (invisible to students, nobody notified) until Google has returned a Meet link; then it
becomes SCHEDULED, bookings are created and students notified. External calls cannot join a database transaction,
so every step is idempotent: the Google event id and the conference requestId are chosen by HALQA before the first
call and reused on every retry, and a GoogleEvent row exists once per occurrence (unique constraint).
"""
from __future__ import annotations

import hashlib
import logging
import time
from datetime import timedelta
from zoneinfo import ZoneInfo

from django.db import transaction
from django.utils import timezone

from apps.accounts.models import AccountStatus, Role
from apps.core.audit import audit
from apps.core.exceptions import ApiError
from apps.scheduling.models import Booking, CircleMember, SessionOccurrence

from . import google
from .google import GoogleError
from .models import GoogleCalendarConnection, GoogleEvent

log = logging.getLogger(__name__)
S = GoogleEvent.Sync
O = SessionOccurrence.Status
MAX_ATTEMPTS = 8
CONFERENCE_POLLS = 3

MESSAGES = {
    "not_connected": "اربط Google Calendar من «حسابي» أولًا لإنشاء الجلسة.",
    "reconnect_required": "يجب إعادة ربط Google Calendar قبل إنشاء الجلسة.",
    "not_configured": "ربط Google Calendar غير مفعّل على الخادم بعد.",
    "forbidden": "رفض Google الطلب. أعد ربط Google Calendar وتأكد من السماح بإدارة الأحداث.",
}
GENERIC = "تعذّر إنشاء Google Meet. أعد المحاولة."


def message(code: str) -> str:
    return MESSAGES.get(code, GENERIC)


def api_error(e: GoogleError) -> ApiError:
    status = 409 if e.code in ("not_connected", "reconnect_required") else 503 if e.code == "not_configured" else 502
    return ApiError(f"google_{e.code}", message(e.code), status)


def connection_for(teacher) -> GoogleCalendarConnection:
    if not google.configured():
        raise GoogleError("not_configured")
    conn = GoogleCalendarConnection.objects.filter(teacher=teacher).first()
    if conn is None or conn.status == GoogleCalendarConnection.Status.REVOKED:
        raise GoogleError("not_connected")
    if conn.status == GoogleCalendarConnection.Status.RECONNECT:
        raise GoogleError("reconnect_required")
    return conn


# ---- what goes to Google ----------------------------------------------------------------------------------------
def invitees(occ: SessionOccurrence, ev: GoogleEvent) -> list:
    """Students who may attend: the session's student, or the circle's active members; only active accounts (never
    deleted, suspended or archived ones, never inactive members)."""
    if occ.circle_id:
        ids = CircleMember.objects.filter(circle_id=occ.circle_id, active=True).values_list("student_id", flat=True)
        from apps.accounts.models import User

        return list(User.objects.filter(pk__in=ids, role=Role.STUDENT, status=AccountStatus.ACTIVE, is_active=True).order_by("pk"))
    s = ev.student
    return [s] if s and s.status == AccountStatus.ACTIVE and s.is_active else []


def _attendees(occ, ev) -> list[dict]:
    return [{"email": u.email} for u in invitees(occ, ev)]


def _hash(attendees: list[dict]) -> str:
    return hashlib.sha256(",".join(sorted(a["email"] for a in attendees)).encode()).hexdigest()


def summary(occ: SessionOccurrence, ev: GoogleEvent) -> str:
    kind = occ.get_topic_display() if occ.topic else "جلسة"
    who = occ.circle.name if occ.circle_id else (ev.student.full_name if ev.student else "")
    title = f" — {occ.title}" if occ.title else ""
    return f"HALQA — جلسة {kind} — {who}{title}"[:250]


def event_body(occ: SessionOccurrence, ev: GoogleEvent, tz: str) -> dict:
    """No academic details: no mistakes, grades, notes or the preparation note — only what the invite needs."""
    kind = occ.get_topic_display() if occ.topic else "جلسة"
    return {
        "summary": summary(occ, ev),
        "description": f"جلسة على منصة الحلقة\nنوع الجلسة: {kind}\nإدارة الجلسة والتقييم من خلال HALQA",
        "start": {"dateTime": occ.starts_at.astimezone(ZoneInfo(tz)).isoformat(), "timeZone": tz},
        "end": {"dateTime": occ.ends_at.astimezone(ZoneInfo(tz)).isoformat(), "timeZone": tz},
        "attendees": _attendees(occ, ev),
        "guestsCanInviteOthers": False,
        "guestsCanSeeOtherGuests": not occ.circle_id,  # circle members do not see each other's emails
        "reminders": {"useDefault": True},
    }


def _tz(teacher) -> str:
    return teacher.timezone or "Africa/Cairo"


# ---- creation ---------------------------------------------------------------------------------------------------
def try_create(ev_id: int) -> GoogleEvent:
    """Create (or find) the Google event for a pending session and, once Google returns the Meet link, publish the
    session. Safe to call again at any time: the same event id and conference request id are used every time."""
    with transaction.atomic():
        ev = GoogleEvent.objects.select_for_update(of=("self",)).select_related("occurrence", "occurrence__circle", "teacher", "student").get(pk=ev_id)
        occ = ev.occurrence
        if ev.sync_status in (S.READY, S.CANCELLED) or occ.status == O.CANCELLED:
            return ev
        ev.attempts += 1
        try:
            conn = connection_for(ev.teacher)
            body = {**event_body(occ, ev, _tz(ev.teacher)), "id": ev.event_id,
                    "conferenceData": {"createRequest": {"requestId": str(ev.request_id), "conferenceSolutionKey": {"type": "hangoutsMeet"}}}}
            params = {"conferenceDataVersion": 1, "sendUpdates": "all"}
            try:
                data = google.calendar(conn, "POST", f"/calendars/{ev.calendar_id}/events", params=params, json=body)
            except GoogleError as e:
                if e.code != "conflict":
                    raise
                # Created by an earlier attempt whose answer was lost: read it back instead of creating another.
                data = google.calendar(conn, "GET", f"/calendars/{ev.calendar_id}/events/{ev.event_id}", params={"conferenceDataVersion": 1})
            url, conf_id, cstatus = google.meet_of(data)
            for _ in range(CONFERENCE_POLLS):  # Google may finish the Meet asynchronously
                if url or cstatus == "failure":
                    break
                time.sleep(1)
                data = google.calendar(conn, "GET", f"/calendars/{ev.calendar_id}/events/{ev.event_id}", params={"conferenceDataVersion": 1})
                url, conf_id, cstatus = google.meet_of(data)
            ev.html_link = str(data.get("htmlLink", ""))[:1000]
            ev.last_synced_at = timezone.now()
            if not url:
                ev.sync_status, ev.last_error = (S.FAILED, "conference_failed") if cstatus == "failure" else (S.PENDING, "conference_pending")
                ev.save()
                return ev
            ev.meet_url, ev.conference_id, ev.sync_status, ev.last_error = url, conf_id, S.READY, ""
            ev.attendees_hash = _hash(body["attendees"])
            ev.save()
            _publish(occ, ev)
            return ev
        except GoogleError as e:
            ev.sync_status = S.RECONNECT if e.code in ("reconnect_required", "not_connected") else S.FAILED
            ev.last_error = e.code
            ev.save()
            log.warning("google_event_create_failed", extra={"occurrence": occ.pk, "reason_code": e.code, "status": e.status, "attempt": ev.attempts})
            return ev


def _publish(occ: SessionOccurrence, ev: GoogleEvent) -> None:
    """The Meet exists: the session becomes visible, students are booked and notified (after commit)."""
    occ.status, occ.meeting_url, occ.meeting_provider = O.SCHEDULED, ev.meet_url, "google_meet"
    occ.save(update_fields=["status", "meeting_url", "meeting_provider", "updated_at"])
    if occ.circle_id:
        from apps.scheduling.membership import sync_circle

        sync_circle(occ.circle)  # books active members with the circle's usual capacity and clash rules
    elif ev.student_id and invitees(occ, ev):
        Booking.objects.get_or_create(occurrence=occ, student=ev.student, status=Booking.Status.CONFIRMED,
                                      defaults={"idempotency_key": f"gcal-{occ.pk}"})
    audit("session.google_ready", actor=None, target=occ, teacher=ev.teacher_id)
    kind = occ.get_topic_display() if occ.topic else ""
    from apps.notifications.services import after_commit

    for b in occ.bookings.filter(status=Booking.Status.CONFIRMED).select_related("student"):
        local = timezone.localtime(occ.starts_at, ZoneInfo(b.student.timezone or "Africa/Cairo"))
        after_commit(b.student, "booking_created", f"تم حجز جلسة {kind}".strip(), _when_text(local), link="/sessions",
                     dedupe=f"gcal-ready:{occ.pk}:{b.student_id}", data={"booking": b.pk, "occurrence": occ.pk})


DAYS = ["الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد"]


def _when_text(local) -> str:
    h = local.hour % 12 or 12
    ampm = "ص" if local.hour < 12 else "م"
    return f"يوم {DAYS[local.weekday()]} الساعة {h}:{local.minute:02d} {ampm}"


# ---- changes ----------------------------------------------------------------------------------------------------
def patch_times(occ: SessionOccurrence) -> None:
    """Called inside the reschedule transaction: the SAME event moves (conference kept), attendees told. Raises
    ApiError (the caller's transaction rolls back) when Google refuses."""
    ev = getattr(occ, "google_event", None)
    if ev is None or ev.sync_status != S.READY:
        return
    try:
        conn = connection_for(ev.teacher)
        body = event_body(occ, ev, _tz(ev.teacher))
        google.calendar(conn, "PATCH", f"/calendars/{ev.calendar_id}/events/{ev.event_id}",
                        params={"conferenceDataVersion": 1, "sendUpdates": "all"},
                        json={k: body[k] for k in ("summary", "start", "end", "attendees")})
    except GoogleError as e:
        raise api_error(e) from None
    GoogleEvent.objects.filter(pk=ev.pk).update(last_synced_at=timezone.now(), attendees_hash=_hash(body["attendees"]), last_error="")


def cancel_event(occurrence_id: int) -> None:
    """After a HALQA cancellation commits: delete the Google event (attendees told). If Google is unreachable the
    request is kept (cancel_pending) and retried by the hourly job; HALQA's own cancellation already stands."""
    ev = GoogleEvent.objects.select_related("teacher").filter(occurrence_id=occurrence_id).first()
    if ev is None or ev.sync_status == S.CANCELLED:
        return
    if ev.sync_status != S.READY and not ev.html_link:
        GoogleEvent.objects.filter(pk=ev.pk).update(sync_status=S.CANCELLED, cancel_pending=False)  # nothing at Google yet
        return
    try:
        conn = connection_for(ev.teacher)
        google.calendar(conn, "DELETE", f"/calendars/{ev.calendar_id}/events/{ev.event_id}", params={"sendUpdates": "all"})
    except GoogleError as e:
        if e.code != "not_found":
            GoogleEvent.objects.filter(pk=ev.pk).update(cancel_pending=True, last_error=e.code)
            log.warning("google_event_cancel_failed", extra={"occurrence": occurrence_id, "reason_code": e.code})
            return
    GoogleEvent.objects.filter(pk=ev.pk).update(sync_status=S.CANCELLED, cancel_pending=False, last_error="", last_synced_at=timezone.now())
    audit("session.google_cancelled", actor=None, target=ev.occurrence, teacher=ev.teacher_id)


def refresh_attendees(ev: GoogleEvent) -> bool:
    """Circle membership or account status changed before the session: update the invite list (same event)."""
    occ = ev.occurrence
    if ev.sync_status != S.READY or occ.status != O.SCHEDULED or occ.starts_at <= timezone.now():
        return False
    att = _attendees(occ, ev)
    h = _hash(att)
    if h == ev.attendees_hash:
        return False
    conn = connection_for(ev.teacher)
    google.calendar(conn, "PATCH", f"/calendars/{ev.calendar_id}/events/{ev.event_id}", params={"conferenceDataVersion": 1, "sendUpdates": "all"},
                    json={"attendees": att})
    GoogleEvent.objects.filter(pk=ev.pk).update(attendees_hash=h, last_synced_at=timezone.now())
    return True


def resync(ev: GoogleEvent) -> GoogleEvent:
    """Admin «إعادة المزامنة»: finish creation, or refresh a ready event. A new Meet is requested only when the event
    has no conference at all (never replacing a working link)."""
    if ev.sync_status in (S.PENDING, S.FAILED, S.RECONNECT):
        return try_create(ev.pk)
    if ev.sync_status == S.READY:
        conn = connection_for(ev.teacher)
        data = google.calendar(conn, "GET", f"/calendars/{ev.calendar_id}/events/{ev.event_id}", params={"conferenceDataVersion": 1})
        url, conf_id, _ = google.meet_of(data)
        if not url:
            import uuid

            ev.request_id = uuid.uuid4()
            data = google.calendar(conn, "PATCH", f"/calendars/{ev.calendar_id}/events/{ev.event_id}", params={"conferenceDataVersion": 1},
                                   json={"conferenceData": {"createRequest": {"requestId": str(ev.request_id), "conferenceSolutionKey": {"type": "hangoutsMeet"}}}})
            url, conf_id, _ = google.meet_of(data)
        if url and url != ev.meet_url:
            ev.meet_url, ev.conference_id = url, conf_id
            SessionOccurrence.objects.filter(pk=ev.occurrence_id).update(meeting_url=url, meeting_provider="google_meet")
        ev.last_synced_at = timezone.now()
        ev.save()
        refresh_attendees(ev)
    if ev.cancel_pending:
        cancel_event(ev.occurrence_id)
    return ev


def run_due(now=None) -> dict:
    """Hourly: finish pending creations, retry failed ones (bounded), poll late Meet links, complete cancellations
    Google did not accept, and keep invite lists in step with circle membership."""
    now = now or timezone.now()
    out = {"created": 0, "still_pending": 0, "cancelled": 0, "attendees": 0, "errors": 0}
    retry = GoogleEvent.objects.filter(sync_status__in=[S.PENDING, S.FAILED], attempts__lt=MAX_ATTEMPTS, occurrence__starts_at__gt=now,
                                       occurrence__status=O.PENDING)
    for ev in retry.order_by("occurrence__starts_at")[:50]:
        ev = try_create(ev.pk)
        out["created" if ev.sync_status == S.READY else "still_pending"] += 1
    for ev in GoogleEvent.objects.filter(cancel_pending=True)[:50]:
        cancel_event(ev.occurrence_id)
        out["cancelled"] += 1
    ready = GoogleEvent.objects.filter(sync_status=S.READY, occurrence__status=O.SCHEDULED, occurrence__starts_at__gt=now,
                                       occurrence__starts_at__lt=now + timedelta(days=31)).select_related("occurrence", "teacher", "student")
    for ev in ready[:200]:
        try:
            out["attendees"] += int(refresh_attendees(ev))
        except GoogleError as e:
            out["errors"] += 1
            log.warning("google_attendees_failed", extra={"occurrence": ev.occurrence_id, "reason_code": e.code})
    return out
