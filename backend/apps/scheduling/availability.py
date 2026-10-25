"""Teacher availability across the whole day (owner request, 25 October 2026).

A teacher describes WHEN they are generally willing to teach, as ranges on any time of the day (00:00–23:59): weekly
ranges (AvailabilityRule; an end earlier than the start runs past midnight) and changes for one date only
(AvailabilityException: the date closed, extra ranges, «حظر وقت»). Nothing is pre-created: the bookable start times
are computed here, on demand, from

    windows (weekly + extra, minus closed dates)  −  blocked time  −  the teacher's real sessions (± minimum gap)
    −  Google Calendar busy time (when connected)  −  outside the booking window (lead time / horizon)

stepping every `slot_increment_minutes` (15 or 30) and keeping only sessions that END inside their window. Every
calculation is done with aware datetimes: wall-clock times are interpreted in the window's timezone (default
Africa/Cairo) and compared in UTC; a wall-clock time that does not exist (a DST gap) is skipped.

A computed slot is identified by an opaque token «s:<teacher>:<epoch>:<minutes>». Booking it (book_slot) re-checks
everything on the server under a per-teacher lock, then creates the session row; the database's exclusion constraint
(teacher_no_overlapping_sessions) is the final guard, so a teacher can never be double-booked.

Session rows produced from a weekly range that nobody holds («placeholders»: the old fixed-slot generator's rows, or a
computed booking later cancelled — individual, no confirmed booking, no live waitlist offer, no Google event) do not count as busy; when a booking needs their
time they are closed (status cancelled) inside the same transaction. Booked sessions are never touched.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.core.cache import cache
from django.db.models import Count, Q

from apps.core.exceptions import ApiError
from apps.core.models import AppSettings

from .models import AvailabilityException, AvailabilityRule, Booking, SessionOccurrence

log = logging.getLogger(__name__)
UTC = ZoneInfo("UTC")
DAY = 1440
WEEK = 7 * DAY
DEFAULT_DURATIONS = [30, 45, 60]
UNAVAILABLE = ApiError("slot_unavailable", "لم يعد هذا الموعد متاحًا. اختر موعدًا آخر.", 409)


# ---- settings -------------------------------------------------------------------------------------------------
def increment(cfg=None) -> int:
    v = (cfg or AppSettings.load()).slot_increment_minutes
    return v if v in (15, 30) else 15


def durations(cfg=None) -> list[int]:
    raw = (cfg or AppSettings.load()).session_durations or DEFAULT_DURATIONS
    return sorted({int(x) for x in raw if str(x).isdigit() and 10 <= int(x) <= 240}) or DEFAULT_DURATIONS


def gap(cfg=None) -> int:
    return int((cfg or AppSettings.load()).session_buffer_minutes or 0)


def academy_tz(cfg=None) -> str:
    return (cfg or AppSettings.load()).default_timezone or "Africa/Cairo"


# ---- time helpers ---------------------------------------------------------------------------------------------
def mins(t: time) -> int:
    return t.hour * 60 + t.minute


def length(start: time, end: time) -> int:
    """Minutes from start to end; an end at or before the start runs into the next day (0 = empty range)."""
    return (mins(end) - mins(start)) % DAY


def aware(day: date, t: time, tz: ZoneInfo) -> datetime:
    return datetime.combine(day, t, tzinfo=tz).astimezone(UTC)


def exists(day: date, t: time, tz: ZoneInfo) -> bool:
    """False for a wall-clock time skipped by a DST change."""
    local = datetime.combine(day, t, tzinfo=tz)
    return local.astimezone(UTC).astimezone(tz).replace(tzinfo=None) == local.replace(tzinfo=None)


def overlaps(a0, a1, b0, b1) -> bool:
    return a0 < b1 and b0 < a1


# ---- windows and blocked time ---------------------------------------------------------------------------------
@dataclass
class Window:
    start: datetime  # aware UTC
    end: datetime
    minutes: int     # session length offered in this window
    tz: str
    rule_id: int | None
    source: str      # "weekly" | "extra"


def _range(day: date, start: time, end: time, tz: ZoneInfo) -> tuple[datetime, datetime]:
    end_day = day + timedelta(days=1) if mins(end) <= mins(start) else day
    return aware(day, start, tz), aware(end_day, end, tz)


def windows_and_blocks(teacher, first: date, last: date, cfg=None) -> tuple[list[Window], list[tuple[datetime, datetime]]]:
    """Windows and blocked intervals for local dates first..last (the day before `first` too: its overnight
    windows reach into `first`)."""
    cfg = cfg or AppSettings.load()
    start_day = first - timedelta(days=1)
    rules = [r for r in AvailabilityRule.objects.filter(teacher=teacher, active=True) if r.valid_until is None or r.valid_until >= start_day]
    exc = list(AvailabilityException.objects.filter(teacher=teacher, date__gte=start_day, date__lte=last))
    closed = {e.date for e in exc if e.kind == AvailabilityException.Kind.OFF and e.start_time is None}
    wins: list[Window] = []
    blocks: list[tuple[datetime, datetime]] = []
    day = start_day
    while day <= last:
        if day not in closed:
            for r in rules:
                if r.weekday == day.weekday() and r.valid_from <= day and (r.valid_until is None or day <= r.valid_until):
                    s, e = _range(day, r.start_time, r.end_time, ZoneInfo(r.timezone))
                    wins.append(Window(s, e, r.session_minutes, r.timezone, r.pk, "weekly"))
        for x in exc:
            if x.date != day or x.start_time is None or x.end_time is None:
                continue
            s, e = _range(day, x.start_time, x.end_time, ZoneInfo(x.timezone))
            if x.kind == AvailabilityException.Kind.EXTRA:
                wins.append(Window(s, e, x.session_minutes or cfg.individual_minutes, x.timezone, None, "extra"))
            else:  # BLOCKED, or an OFF with times (older rows): the time is unavailable
                blocks.append((s, e))
        day += timedelta(days=1)
    return wins, blocks


# ---- busy time ------------------------------------------------------------------------------------------------
def _sessions(teacher, frm: datetime, to: datetime):
    now = datetime.now(UTC)
    return (SessionOccurrence.objects.filter(teacher=teacher, starts_at__lt=to, ends_at__gt=frm)
            .exclude(status=SessionOccurrence.Status.CANCELLED)
            .annotate(confirmed=Count("bookings", filter=Q(bookings__status=Booking.Status.CONFIRMED), distinct=True),
                      offered=Count("waitlist", filter=Q(waitlist__status="offered", waitlist__offer_expires_at__gt=now), distinct=True))
            .select_related("circle"))


def is_placeholder(o) -> bool:
    """A free session row produced from a weekly range (the old fixed-slot generator, or a computed booking that was
    later cancelled): nobody holds it, so its time is simply part of the computed availability. Sessions opened
    explicitly (by the teacher or an admin) are real offers and stay listed."""
    return (o.source_rule_id is not None and o.status == SessionOccurrence.Status.SCHEDULED and o.kind == SessionOccurrence.Kind.INDIVIDUAL and o.circle_id is None
            and getattr(o, "confirmed", 0) == 0 and getattr(o, "offered", 0) == 0 and not o.topic and not o.title
            and not hasattr(o, "google_event"))


def busy(teacher, frm: datetime, to: datetime) -> list[SessionOccurrence]:
    """The teacher's real sessions overlapping [frm, to): booked individual sessions, circle/group sessions, sessions
    the teacher created (with or without Google), sessions being prepared."""
    return [o for o in _sessions(teacher, frm, to).select_related("google_event") if not is_placeholder(o)]


def google_busy(teacher, frm: datetime, to: datetime, *, live: bool = False) -> list[tuple[datetime, datetime]]:
    """Busy time in the teacher's connected Google Calendar (primary). HALQA's own events are skipped (their sessions
    are already counted), as are free/transparent and all-day events. Never removes HALQA availability: it only hides
    the conflicting start times. A Google error keeps the last known answer (or none), and is logged."""
    from apps.integrations.models import GoogleCalendarConnection

    conn = GoogleCalendarConnection.objects.filter(teacher=teacher, status=GoogleCalendarConnection.Status.ACTIVE).first()
    if conn is None:
        return []
    day0, day1 = frm.astimezone(UTC).date(), to.astimezone(UTC).date() + timedelta(days=1)
    key = f"gbusy:{teacher.pk}:{day0}:{day1}"
    if not live:
        hit = cache.get(key)
        if hit is not None:
            return [(datetime.fromisoformat(a), datetime.fromisoformat(b)) for a, b in hit]
    try:
        spans = _google_events(conn, datetime.combine(day0, time(0), tzinfo=UTC), datetime.combine(day1, time(0), tzinfo=UTC))
    except Exception as e:  # noqa: BLE001 — Google is optional: never break booking because it is unreachable
        log.warning("google_busy_failed", extra={"err_code": getattr(e, "code", type(e).__name__)})
        hit = cache.get(key + ":last")
        return [(datetime.fromisoformat(a), datetime.fromisoformat(b)) for a, b in hit] if hit else []
    raw = [(a.isoformat(), b.isoformat()) for a, b in spans]
    cache.set(key, raw, 120)
    cache.set(key + ":last", raw, 24 * 3600)
    return spans


def _google_events(conn, time_min: datetime, time_max: datetime) -> list[tuple[datetime, datetime]]:
    from apps.integrations import google

    out, token = [], None
    for _ in range(4):  # at most 1000 events in the window
        params = {"timeMin": time_min.isoformat().replace("+00:00", "Z"), "timeMax": time_max.isoformat().replace("+00:00", "Z"),
                  "singleEvents": "true", "maxResults": "250"}
        if token:
            params["pageToken"] = token
        body = google.calendar(conn, "GET", "/calendars/primary/events", params=params)
        for ev in body.get("items") or []:
            if ev.get("status") == "cancelled" or ev.get("transparency") == "transparent" or str(ev.get("id", "")).startswith("halqa"):
                continue
            s, e = (ev.get("start") or {}).get("dateTime"), (ev.get("end") or {}).get("dateTime")
            if not s or not e:  # all-day events (birthdays, holidays) do not block teaching time
                continue
            out.append((datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(UTC), datetime.fromisoformat(e.replace("Z", "+00:00")).astimezone(UTC)))
        token = body.get("nextPageToken")
        if not token:
            break
    return out


# ---- the computed slots ---------------------------------------------------------------------------------------
@dataclass
class Slot:
    start: datetime
    end: datetime
    minutes: int
    rule_id: int | None


def token_for(teacher_id: int, start: datetime, minutes: int) -> str:
    return f"s:{teacher_id}:{int(start.timestamp())}:{minutes}"


def parse_token(raw) -> tuple[int, datetime, int] | None:
    parts = str(raw or "").split(":")
    if len(parts) != 4 or parts[0] != "s" or not all(p.isdigit() for p in parts[1:]):
        return None
    tid, epoch, minutes = int(parts[1]), int(parts[2]), int(parts[3])
    if not (10 <= minutes <= 240):
        return None
    return tid, datetime.fromtimestamp(epoch, UTC), minutes


def compute(teacher, frm: datetime, to: datetime, *, now: datetime | None = None, cfg=None, google_live: bool = False,
            minutes: int | None = None) -> list[Slot]:
    """Bookable individual start times with frm <= start <= to."""
    cfg = cfg or AppSettings.load()
    now = now or datetime.now(UTC)
    lo = max(frm, now + timedelta(minutes=cfg.booking_lead_minutes))
    hi = min(to, now + timedelta(days=cfg.booking_horizon_days))
    if hi < lo:
        return []
    tz0 = ZoneInfo(academy_tz(cfg))
    wins, blocks = windows_and_blocks(teacher, lo.astimezone(tz0).date() - timedelta(days=1), hi.astimezone(tz0).date() + timedelta(days=1), cfg)
    if not wins:
        return []
    pad = timedelta(minutes=gap(cfg))
    span0, span1 = lo - timedelta(days=1), hi + timedelta(days=1)
    taken = [(o.starts_at - pad, o.ends_at + pad) for o in busy(teacher, span0, span1)]
    gbusy = google_busy(teacher, span0, span1, live=google_live)
    step = timedelta(minutes=increment(cfg))
    seen: set[tuple[datetime, int]] = set()
    out: list[Slot] = []
    for w in sorted(wins, key=lambda w: w.start):
        if minutes is not None and w.minutes != minutes:
            continue
        tz = ZoneInfo(w.tz)
        length_ = timedelta(minutes=w.minutes)
        local = w.start.astimezone(tz).replace(tzinfo=None)
        r = (local.hour * 60 + local.minute) % increment(cfg)  # first start on the increment grid
        if r:
            local += timedelta(minutes=increment(cfg) - r)
        while True:
            lt = local.replace(tzinfo=tz)
            s = lt.astimezone(UTC)
            e = s + length_
            if e > w.end:
                break
            local += step
            if lt.astimezone(UTC).astimezone(tz).replace(tzinfo=None) != lt.replace(tzinfo=None):
                continue  # DST gap
            if s < lo or s > hi or (s, w.minutes) in seen:
                continue
            if any(overlaps(s, e, a, b) for a, b in blocks) or any(overlaps(s, e, a, b) for a, b in taken) \
                    or any(overlaps(s, e, a, b) for a, b in gbusy):
                continue
            seen.add((s, w.minutes))
            out.append(Slot(s, e, w.minutes, w.rule_id))
    out.sort(key=lambda x: (x.start, x.minutes))
    return out


def check(teacher, start: datetime, minutes: int, *, now: datetime | None = None, cfg=None, google_live: bool = True) -> Slot:
    """The server's own check before a booking: is this exact start (and length) still offered?"""
    found = [x for x in compute(teacher, start, start, now=now, cfg=cfg, google_live=google_live, minutes=minutes) if x.start == start]
    if not found:
        raise UNAVAILABLE
    return found[0]


def free_placeholders(teacher, start: datetime, end: datetime) -> list[SessionOccurrence]:
    return [o for o in _sessions(teacher, start, end).select_related("google_event") if is_placeholder(o)]
