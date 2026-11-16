"""Individual and group sessions with weekly recurrence (owner request, 16 Nov 2026).

Built on the existing scheduling rows (nothing is replaced):
- a session is a SessionOccurrence (kind «فردية» / «جماعية»); each participant is a confirmed Booking, which already
  holds per-student attendance. SessionEvaluation adds the per-student memorization / tajweed record.
- a weekly series is a RecurringSessionRule with its slots (weekday + local time + minutes), participants and
  exceptions. Sessions are generated HORIZON_DAYS ahead, when the series is created or changed and by the hourly job
  (`generate_recurring_sessions`), so the teacher never re-creates them.

Rules the database backs up:
- one live session per (slot, local date): `series_one_session_per_slot_date`;
- a teacher never has two overlapping live sessions (exclusion constraint): a generated time that clashes is skipped
  and reported, never double-booked;
- a student has one active participation per series and one confirmed booking per session; a student who already has
  another session at that time is not booked into it (reported as a conflict);
- participants are the teacher's assigned students; only an admin can add anyone else (that is the admin's grant).

Notifications go through the existing outbox (in-app + Web Push), once per event and person (dedupe keys): the
series' creation, being added or removed, pause / resume / cancel. Generated sessions do not notify one by one. The
15-minute reminder (reminders.py) covers every confirmed participant and the teacher of every session.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.accounts.models import AccountStatus, Role
from apps.core.exceptions import ApiError
from apps.core.timefmt import WEEKDAYS, ar_digits, clock, when as local_when

from .models import (Booking, RecurringSessionException, RecurringSessionParticipant, RecurringSessionRule, RecurringSessionSlot,
                     SessionOccurrence)

log = logging.getLogger(__name__)

HORIZON_DAYS = 14          # sessions exist this far ahead; the hourly job keeps extending it
START_GRACE = timedelta(minutes=2)   # a slot starting now (or a moment ago) is still created; only the past is skipped
MAX_PARTICIPANTS = 40       # the occurrence capacity limit (occurrence_capacity_range)


class Refuse(ApiError):
    pass


def _bad(field: str, msg: str, code: str = "invalid", status: int = 400):
    return Refuse(code, msg if code != "invalid" else "تحقق من البيانات المُدخلة.", status, {field: [msg]})


# ---- who may take part ------------------------------------------------------------------------------------------
def eligible_students(teacher, ids: list[int], *, by_admin: bool = False):
    """The students for a session: distinct, active, and assigned to the teacher (an admin may add anyone). Raises."""
    from apps.accounts.models import User
    from apps.accounts.permissions import assigned_student_ids

    if not isinstance(ids, list) or not ids or not all(isinstance(i, int) and not isinstance(i, bool) for i in ids):
        raise _bad("students", "اختر طالبًا واحدًا على الأقل.")
    if len(set(ids)) != len(ids):
        raise _bad("students", "الطالب مكرر في القائمة.")
    if len(ids) > MAX_PARTICIPANTS:
        raise _bad("students", f"الحد الأقصى {MAX_PARTICIPANTS} طالبًا في الجلسة.")
    qs = User.objects.filter(pk__in=ids, role=Role.STUDENT, status=AccountStatus.ACTIVE)
    if not by_admin:
        qs = qs.filter(pk__in=assigned_student_ids(teacher))
    found = {u.pk: u for u in qs}
    if len(found) != len(ids):
        raise _bad("students", "طالب غير مرتبط بك أو غير نشط.")
    return [found[i] for i in ids]


def check_kind(kind: str, n: int) -> None:
    if kind not in ("individual", "group"):
        raise _bad("kind", "اختر نوع الجلسة: فردية أو جماعية.")
    if kind == "individual" and n != 1:
        raise _bad("students", "الجلسة الفردية لطالب واحد فقط.")
    if kind == "group" and n < 2:
        raise _bad("students", "الجلسة الجماعية لطالبين أو أكثر.")


# ---- seats in one session ---------------------------------------------------------------------------------------
def _clash(student, occ) -> bool:
    return Booking.objects.filter(student=student, status=Booking.Status.CONFIRMED, occurrence__status=SessionOccurrence.Status.SCHEDULED,
                                  occurrence__starts_at__lt=occ.ends_at, occurrence__ends_at__gt=occ.starts_at).exclude(occurrence=occ).exists()


def seat(occ: SessionOccurrence, student, key: str) -> str:
    """Inside a transaction, with `occ` locked: a confirmed booking for the student. Returns "booked", "already" or
    "conflict". The capacity grows with the participants (up to 40). No notification here (the caller sends one)."""
    if occ.bookings.filter(student=student, status=Booking.Status.CONFIRMED).exists():
        return "already"
    if _clash(student, occ):
        return "conflict"
    taken = occ.bookings.filter(status=Booking.Status.CONFIRMED).count()
    if taken >= occ.capacity:
        if occ.capacity >= MAX_PARTICIPANTS:
            return "conflict"
        occ.capacity = taken + 1
        occ.save(update_fields=["capacity", "updated_at"])
    old = Booking.objects.filter(student=student, idempotency_key=key).first()
    if old is not None:   # removed earlier and added again: the same row comes back
        old.status, old.cancelled_at, old.cancelled_by, old.cancel_reason = Booking.Status.CONFIRMED, None, None, ""
        old._no_alarm = True
        old.save(update_fields=["status", "cancelled_at", "cancelled_by", "cancel_reason", "updated_at"])
        return "booked"
    b = Booking(occurrence=occ, student=student, idempotency_key=key)
    b._no_alarm = True   # the session's own alarm covers every participant (one Cloud Task per session and time)
    try:
        with transaction.atomic():
            b.save()
    except IntegrityError:
        return "already"
    return "booked"


def unseat(occ: SessionOccurrence, student, by, reason: str, now=None) -> int:
    now = now or timezone.now()
    return Booking.objects.filter(occurrence=occ, student=student, status=Booking.Status.CONFIRMED).update(
        status=Booking.Status.CANCELLED, cancelled_at=now, cancelled_by=by, cancel_reason=reason[:200], updated_at=now)


# ---- one session's participants («إنشاء جلسة» and any session of a series) ----------------------------------------
def add_to_session(occ_id: int, student, by) -> Booking:
    with transaction.atomic():
        occ = SessionOccurrence.objects.select_for_update(of=("self",)).select_related("teacher").get(pk=occ_id)
        if occ.status != SessionOccurrence.Status.SCHEDULED or occ.starts_at <= timezone.now():
            raise Refuse("closed", "انتهت هذه الجلسة أو أُلغيت.", 409)
        n = occ.bookings.filter(status=Booking.Status.CONFIRMED).count()
        if occ.kind == SessionOccurrence.Kind.INDIVIDUAL and n >= 1:
            raise Refuse("individual_full", "الجلسة الفردية لطالب واحد. أنشئ جلسة جماعية لأكثر من طالب.", 409)
        r = seat(occ, student, f"session-{occ.pk}-{student.pk}")
        if r == "already":
            raise Refuse("already_participant", "الطالب مشارك في هذه الجلسة بالفعل.", 409)
        if r == "conflict":
            raise Refuse("student_conflict", f"لدى {student.full_name} جلسة أخرى في هذا الوقت.", 409)
        b = Booking.objects.get(occurrence=occ, student=student, status=Booking.Status.CONFIRMED)
        _tell(student, "session_added", "أُضفت إلى جلسة", f"{_label(occ)} مع {occ.teacher.display_name} · {local_when(occ.starts_at, student.timezone)}",
              f"session:{occ.pk}:added:{student.pk}:{int(timezone.now().timestamp())}", {"booking": b.pk, "occurrence": occ.pk}, link=f"/sessions/{b.pk}")
        if by.pk != occ.teacher_id:
            _tell(occ.teacher, "session_participant_added", "أُضيف طالب إلى جلستك", f"{student.full_name} · {local_when(occ.starts_at, occ.teacher.timezone)}",
                  f"session:{occ.pk}:added:{student.pk}:t:{int(timezone.now().timestamp())}", {"occurrence": occ.pk}, link="/teacher/schedule")
    transaction.on_commit(lambda: _arm(occ.pk))
    return b


def remove_from_session(occ_id: int, student, by, reason: str = "") -> int:
    with transaction.atomic():
        occ = SessionOccurrence.objects.select_for_update(of=("self",)).select_related("teacher").get(pk=occ_id)
        if occ.starts_at <= timezone.now():
            raise Refuse("closed", "لا يُعدَّل المشاركون بعد بدء الجلسة؛ سجلّ الحضور يبقى كما هو.", 409)
        left = occ.bookings.filter(status=Booking.Status.CONFIRMED).exclude(student=student).count()
        if left == 0 and occ.status == SessionOccurrence.Status.SCHEDULED:
            raise Refuse("last_participant", "لا يمكن إزالة آخر طالب. ألغِ الجلسة بدلًا من ذلك.", 409)
        n = unseat(occ, student, by, reason or "أُزيل من الجلسة")
        if not n:
            raise Refuse("not_participant", "الطالب ليس مشاركًا في هذه الجلسة.", 404)
        _tell(student, "session_removed", "أُزلت من جلسة", f"{_label(occ)} مع {occ.teacher.display_name} · {local_when(occ.starts_at, student.timezone)}",
              f"session:{occ.pk}:removed:{student.pk}:{int(timezone.now().timestamp())}", {"occurrence": occ.pk}, link="/sessions")
    return n


# ---- weekly series ----------------------------------------------------------------------------------------------
def _label(o) -> str:
    t = (o.title or "").strip()
    kind = "جلسة جماعية" if o.kind == "group" else "جلسة فردية"
    return f"{kind}: {t}" if t else kind


def days_text(rule: RecurringSessionRule) -> str:
    """«الأحد ٧:٠٠ مساءً، والثلاثاء ٨:٣٠ مساءً»"""
    slots = sorted(rule.slots.filter(active=True), key=lambda s: ((s.weekday - 5) % 7, s.start_time))   # the week starts on Saturday
    parts = [f"{WEEKDAYS[s.weekday]} {clock(s.start_time.hour, s.start_time.minute)}" for s in slots]
    return "، و".join(parts)


def _local_start(day: date, t: time, tz: ZoneInfo) -> datetime | None:
    """The instant of a local wall-clock time; None for a time that does not exist that day (DST gap)."""
    st = datetime.combine(day, t, tzinfo=tz)
    utc = st.astimezone(ZoneInfo("UTC"))
    return utc if utc.astimezone(tz).replace(tzinfo=None) == st.replace(tzinfo=None) else None


def _arm(occ_id: int) -> None:
    from .reminders import session_changed

    o = SessionOccurrence.objects.filter(pk=occ_id).first()
    if o is not None:
        session_changed(o)


def generate(rule: RecurringSessionRule, now=None, horizon_days: int = HORIZON_DAYS) -> dict:
    """Create the series' sessions up to the horizon and book its active participants. Idempotent.
    Returns {created, conflicts: [iso start…], booked, student_conflicts}."""
    now = now or timezone.now()
    out = {"created": 0, "conflicts": [], "booked": 0, "student_conflicts": 0}
    rule = RecurringSessionRule.objects.get(pk=rule.pk)
    if rule.status != RecurringSessionRule.Status.ACTIVE:
        return out
    tz = ZoneInfo(rule.timezone)
    today = now.astimezone(tz).date()
    first, last = max(rule.starts_on, today), today + timedelta(days=horizon_days)
    if rule.ends_on:
        last = min(last, rule.ends_on)
    slots = list(rule.slots.filter(active=True))
    skip = set(RecurringSessionException.objects.filter(rule=rule, date__gte=first, date__lte=last).values_list("date", "slot_id"))
    students = [p.student for p in rule.participants.filter(active=True, student__status=AccountStatus.ACTIVE).select_related("student")]
    made = []
    day = first
    while day <= last:
        for s in slots:
            if s.weekday != day.weekday() or (day, None) in skip or (day, s.pk) in skip:
                continue
            start = _local_start(day, s.start_time, tz)
            if start is None or start < now - START_GRACE:
                continue
            if SessionOccurrence.objects.filter(series_slot=s, series_date=day).exclude(status=SessionOccurrence.Status.CANCELLED).exists():
                continue
            try:
                with transaction.atomic():
                    occ = SessionOccurrence.objects.create(
                        teacher=rule.teacher, kind=rule.kind, starts_at=start, ends_at=start + timedelta(minutes=s.minutes),
                        capacity=max(1, min(MAX_PARTICIPANTS, len(students))), status=SessionOccurrence.Status.SCHEDULED,
                        topic=rule.topic, title=rule.title, prep_note=rule.prep_note, meeting_url=rule.meeting_url,
                        meeting_provider=rule.meeting_provider, series=rule, series_slot=s, series_date=day)
            except IntegrityError:   # the teacher has another session then (or a concurrent run made this one)
                if not SessionOccurrence.objects.filter(series_slot=s, series_date=day).exclude(status="cancelled").exists():
                    out["conflicts"].append(start.isoformat())
                continue
            out["created"] += 1
            made.append(occ.pk)
        day += timedelta(days=1)
    r = sync_participants(rule, now=now)
    out["booked"], out["student_conflicts"] = r["booked"], r["conflict"]
    return out


def sync_participants(rule: RecurringSessionRule, now=None) -> dict:
    """Every upcoming session of the series has exactly the active participants (booked unless they have another
    session then). Bookings of removed participants in upcoming sessions are cancelled; past ones never change."""
    now = now or timezone.now()
    out = {"booked": 0, "conflict": 0, "removed": 0}
    active = {p.student_id: p.student for p in rule.participants.filter(active=True, student__status=AccountStatus.ACTIVE).select_related("student")}
    for occ_id in SessionOccurrence.objects.filter(series=rule, status=SessionOccurrence.Status.SCHEDULED, starts_at__gt=now).values_list("pk", flat=True):
        with transaction.atomic():
            occ = SessionOccurrence.objects.select_for_update(of=("self",)).get(pk=occ_id)
            gone = occ.bookings.filter(status=Booking.Status.CONFIRMED).exclude(student_id__in=list(active)).values_list("student_id", flat=True)
            for sid in list(gone):
                if RecurringSessionParticipant.objects.filter(rule=rule, student_id=sid).exists():  # added by hand to this one session otherwise
                    out["removed"] += Booking.objects.filter(occurrence=occ, student_id=sid, status=Booking.Status.CONFIRMED).update(
                        status=Booking.Status.CANCELLED, cancelled_at=now, cancel_reason="انتهت المشاركة في الجلسات الأسبوعية", updated_at=now)
            for st in active.values():
                r = seat(occ, st, f"series-{rule.pk}-{occ.pk}-{st.pk}")
                out["booked"] += r == "booked"
                out["conflict"] += r == "conflict"
        transaction.on_commit(lambda pk=occ_id: _arm(pk))
    return out


def _cancel_future(rule: RecurringSessionRule, by, reason: str, now=None, *, after: date | None = None, slots=None) -> int:
    """Cancel the series' upcoming sessions (all, those after a date, or those of some slots) without a message per
    session; the caller notifies each participant once. Returns how many sessions."""
    now = now or timezone.now()
    qs = SessionOccurrence.objects.filter(series=rule, status=SessionOccurrence.Status.SCHEDULED, starts_at__gt=now)
    if after is not None:
        qs = qs.filter(series_date__gt=after)
    if slots is not None:
        qs = qs.filter(series_slot__in=slots)
    ids = list(qs.values_list("pk", flat=True))
    Booking.objects.filter(occurrence_id__in=ids, status=Booking.Status.CONFIRMED).update(
        status=Booking.Status.CANCELLED, cancelled_at=now, cancelled_by=by, cancel_reason=reason[:200], updated_at=now)
    SessionOccurrence.objects.filter(pk__in=ids).update(status=SessionOccurrence.Status.CANCELLED, updated_at=now)
    return len(ids)


def _tell(user, kind, title, body, dedupe, data, link="/sessions") -> None:
    from apps.notifications.services import after_commit

    after_commit(user, kind, title, body, link=link, dedupe=dedupe, data=data)


def _participants(rule):
    return [p.student for p in rule.participants.filter(active=True).select_related("student")]


def create_series(*, teacher, by, kind: str, students: list, slots: list[dict], topic: str = "", title: str = "", prep_note: str = "",
                  meeting_url: str = "", starts_on: date | None = None, ends_on: date | None = None, key: str = "") -> tuple[RecurringSessionRule, dict, bool]:
    """Returns (rule, generation result, created). `slots`: [{weekday 0–6 (Mon=0), time "HH:MM", minutes}]."""
    from .meeting import InvalidMeetingLink, normalize, provider_for

    if key:
        prior = RecurringSessionRule.objects.filter(teacher=teacher, creation_key=key).first()
        if prior is not None:
            return prior, {"created": 0, "conflicts": [], "booked": 0, "student_conflicts": 0}, False
    check_kind(kind, len(students))
    clean = _clean_slots(slots)
    provider = ""
    if meeting_url.strip():
        try:
            meeting_url = normalize(meeting_url)
            provider = provider_for(meeting_url)
        except InvalidMeetingLink as e:
            raise _bad("meeting_url", str(e)) from None
    else:
        meeting_url = ""
    tz = teacher.timezone or "Africa/Cairo"
    today = timezone.now().astimezone(ZoneInfo(tz)).date()
    starts_on = starts_on or today
    if starts_on < today:
        raise _bad("starts_on", "اختر تاريخ بداية من اليوم فصاعدًا.")
    if ends_on is not None and ends_on < starts_on:
        raise _bad("ends_on", "تاريخ الانتهاء بعد تاريخ البداية.")
    try:
        with transaction.atomic():
            rule = RecurringSessionRule.objects.create(
                teacher=teacher, kind=kind, title=title.strip()[:120], topic=topic, prep_note=prep_note.strip()[:500], meeting_url=meeting_url,
                meeting_provider=provider, timezone=tz, starts_on=starts_on, ends_on=ends_on, created_by=by, creation_key=key[:64])
            for s in clean:
                RecurringSessionSlot.objects.create(rule=rule, **s)
            for st in students:
                RecurringSessionParticipant.objects.create(rule=rule, student=st, added_by=by)
    except IntegrityError:
        prior = RecurringSessionRule.objects.filter(teacher=teacher, creation_key=key).first() if key else None
        if prior is not None:
            return prior, {"created": 0, "conflicts": [], "booked": 0, "student_conflicts": 0}, False
        raise
    result = generate(rule)
    text = days_text(rule)
    for st in students:
        _tell(st, "series_added", f"جلسات أسبوعية جديدة: {_label(rule)}", f"مع {teacher.display_name} · {text}",
              f"series:{rule.pk}:added:{st.pk}", {"series": rule.pk})
    _tell(teacher, "series_created", "تم إنشاء الجلسات الأسبوعية", f"{_label(rule)} · {text} · {ar_digits(len(students))} طالب",
          f"series:{rule.pk}:created", {"series": rule.pk}, link="/teacher/schedule")
    return rule, result, True


def _clean_slots(slots) -> list[dict]:
    if not isinstance(slots, list) or not slots:
        raise _bad("slots", "اختر يومًا واحدًا على الأقل.")
    out, seen = [], set()
    for s in slots:
        try:
            wd, minutes = int(s["weekday"]), int(s.get("minutes") or 0)
            t = datetime.strptime(str(s["time"])[:5], "%H:%M").time()
        except (KeyError, TypeError, ValueError):
            raise _bad("slots", "يوم أو وقت غير صالح.") from None
        if not 0 <= wd <= 6:
            raise _bad("slots", "يوم غير صالح.")
        if not 15 <= minutes <= 180:
            raise _bad("slots", "المدة بين 15 و180 دقيقة.")
        if (wd, t) in seen:
            raise _bad("slots", "الموعد مكرر.")
        seen.add((wd, t))
        out.append({"weekday": wd, "start_time": t, "minutes": minutes})
    return out


def update_series(rule: RecurringSessionRule, by, data: dict) -> dict:
    """Edit the series: title, topic, prep note, meeting link, end date, and the weekly times. Upcoming sessions follow;
    past sessions never change. Returns the generation result."""
    from .meeting import InvalidMeetingLink, normalize, provider_for

    if rule.status == RecurringSessionRule.Status.CANCELLED:
        raise Refuse("cancelled", "أُلغيت هذه الجلسات الأسبوعية.", 409)
    now = timezone.now()
    fields = {}
    if "title" in data:
        fields["title"] = str(data.get("title") or "").strip()[:120]
    if "topic" in data:
        topic = str(data.get("topic") or "")
        if topic and topic not in SessionOccurrence.Topic.values:
            raise _bad("topic", "نوع غير صالح.")
        fields["topic"] = topic
    if "prep_note" in data:
        fields["prep_note"] = str(data.get("prep_note") or "").strip()[:500]
    if "meeting_url" in data:
        url = str(data.get("meeting_url") or "")
        if url.strip():
            try:
                url = normalize(url)
                fields["meeting_provider"] = provider_for(url)
            except InvalidMeetingLink as e:
                raise _bad("meeting_url", str(e)) from None
        else:
            url, fields["meeting_provider"] = "", ""
        fields["meeting_url"] = url
    ends_changed = "ends_on" in data
    if ends_changed:
        raw = data.get("ends_on")
        try:
            ends = date.fromisoformat(str(raw)) if raw else None
        except ValueError:
            raise _bad("ends_on", "تاريخ غير صالح.") from None
        if ends is not None and ends < rule.starts_on:
            raise _bad("ends_on", "تاريخ الانتهاء بعد تاريخ البداية.")
        fields["ends_on"] = ends
    with transaction.atomic():
        rule = RecurringSessionRule.objects.select_for_update().get(pk=rule.pk)
        for k, v in fields.items():
            setattr(rule, k, v)
        rule.save()
        upcoming = SessionOccurrence.objects.filter(series=rule, status=SessionOccurrence.Status.SCHEDULED, starts_at__gt=now)
        same = {k: v for k, v in fields.items() if k in ("title", "topic", "prep_note", "meeting_url", "meeting_provider")}
        if same:
            upcoming.update(**same, updated_at=now)
        cancelled = 0
        if ends_changed and rule.ends_on is not None:
            cancelled += _cancel_future(rule, by, "انتهت الجلسات الأسبوعية", now, after=rule.ends_on)
        if "slots" in data:
            clean = _clean_slots(data.get("slots"))
            keep, old = set(), list(rule.slots.filter(active=True))
            for s in old:
                match = next((c for c in clean if c["weekday"] == s.weekday and c["start_time"] == s.start_time and c["minutes"] == s.minutes), None)
                if match is not None:
                    keep.add((s.weekday, s.start_time))
            ended = [s for s in old if (s.weekday, s.start_time) not in keep]
            if ended:
                RecurringSessionSlot.objects.filter(pk__in=[s.pk for s in ended]).update(active=False)
                cancelled += _cancel_future(rule, by, "تغيّر موعد الجلسات الأسبوعية", now, slots=ended)
            for c in clean:
                if (c["weekday"], c["start_time"]) not in keep:
                    RecurringSessionSlot.objects.create(rule=rule, **c)
    result = generate(rule)
    if cancelled or "slots" in data or ends_changed:
        text = days_text(rule)
        stamp = int(now.timestamp())
        for st in _participants(rule):
            _tell(st, "series_changed", f"تغيّرت الجلسات الأسبوعية: {_label(rule)}",
                  f"مع {rule.teacher.display_name} · {text}" + (f" · حتى {rule.ends_on.isoformat()}" if rule.ends_on else ""),
                  f"series:{rule.pk}:changed:{st.pk}:{stamp}", {"series": rule.pk})
    return {**result, "cancelled": cancelled}


def set_status(rule: RecurringSessionRule, by, new: str, reason: str = "") -> int:
    """pause (upcoming sessions cancelled, nothing generated), resume (generated again), cancel (for good)."""
    now = timezone.now()
    S = RecurringSessionRule.Status
    with transaction.atomic():
        rule = RecurringSessionRule.objects.select_for_update().select_related("teacher").get(pk=rule.pk)
        if rule.status == S.CANCELLED:
            raise Refuse("cancelled", "أُلغيت هذه الجلسات الأسبوعية.", 409)
        if new == rule.status:
            return 0
        n = 0
        if new in (S.PAUSED, S.CANCELLED):
            n = _cancel_future(rule, by, reason or ("أُوقفت الجلسات الأسبوعية مؤقتًا" if new == S.PAUSED else "أُلغيت الجلسات الأسبوعية"), now)
        rule.status = new
        rule.save(update_fields=["status", "updated_at"])
        title = {S.PAUSED: "أُوقفت الجلسات الأسبوعية مؤقتًا", S.ACTIVE: "استؤنفت الجلسات الأسبوعية", S.CANCELLED: "أُلغيت الجلسات الأسبوعية"}[new]
        for st in _participants(rule):
            _tell(st, f"series_{new}", f"{title}: {_label(rule)}", f"مع {rule.teacher.display_name}" + (f" · {reason}" if reason else ""),
                  f"series:{rule.pk}:{new}:{st.pk}:{int(now.timestamp())}", {"series": rule.pk})
        if by.pk != rule.teacher_id:
            _tell(rule.teacher, f"series_{new}", f"{title}: {_label(rule)}", "بقرار من الإدارة", f"series:{rule.pk}:{new}:t:{int(now.timestamp())}",
                  {"series": rule.pk}, link="/teacher/schedule")
    if new == S.ACTIVE:
        generate(rule)
    return n


def add_participant(rule: RecurringSessionRule, student, by, *, by_admin: bool = False) -> dict:
    eligible_students(rule.teacher, [student.pk], by_admin=by_admin)
    with transaction.atomic():
        rule = RecurringSessionRule.objects.select_for_update().select_related("teacher").get(pk=rule.pk)
        if rule.status == RecurringSessionRule.Status.CANCELLED:
            raise Refuse("cancelled", "أُلغيت هذه الجلسات الأسبوعية.", 409)
        active = rule.participants.filter(active=True)
        if active.filter(student=student).exists():
            raise Refuse("already_participant", "الطالب مشارك بالفعل.", 409)
        if rule.kind == "individual" and active.exists():
            raise Refuse("individual_full", "الجلسات الفردية لطالب واحد. أنشئ جلسات جماعية لأكثر من طالب.", 409)
        if active.count() >= MAX_PARTICIPANTS:
            raise Refuse("full", f"الحد الأقصى {MAX_PARTICIPANTS} طالبًا.", 409)
        p = RecurringSessionParticipant.objects.create(rule=rule, student=student, added_by=by)
        stamp = int(timezone.now().timestamp())
        _tell(student, "series_added", f"أُضفت إلى جلسات أسبوعية: {_label(rule)}", f"مع {rule.teacher.display_name} · {days_text(rule)}",
              f"series:{rule.pk}:added:{student.pk}:{stamp}", {"series": rule.pk})
        if by.pk != rule.teacher_id:
            _tell(rule.teacher, "series_participant_added", "أُضيف طالب إلى جلساتك الأسبوعية", f"{student.full_name} · {_label(rule)}",
                  f"series:{rule.pk}:added:{student.pk}:t:{stamp}", {"series": rule.pk}, link="/teacher/schedule")
    r = sync_participants(rule)
    return {"participant": p.pk, **r}


def remove_participant(rule: RecurringSessionRule, student, by, reason: str = "") -> dict:
    now = timezone.now()
    with transaction.atomic():
        rule = RecurringSessionRule.objects.select_for_update().select_related("teacher").get(pk=rule.pk)
        p = rule.participants.select_for_update().filter(student=student, active=True).first()
        if p is None:
            raise Refuse("not_participant", "الطالب ليس مشاركًا.", 404)
        if rule.status != RecurringSessionRule.Status.CANCELLED and rule.participants.filter(active=True).count() == 1:
            raise Refuse("last_participant", "لا يمكن إزالة آخر طالب. أوقف الجلسات أو ألغها بدلًا من ذلك.", 409)
        p.active, p.ended_at, p.ended_by, p.end_reason = False, now, by, (reason or "")[:200]
        p.save(update_fields=["active", "ended_at", "ended_by", "end_reason", "updated_at"])
        n = Booking.objects.filter(student=student, status=Booking.Status.CONFIRMED, occurrence__series=rule, occurrence__starts_at__gt=now).update(
            status=Booking.Status.CANCELLED, cancelled_at=now, cancelled_by=by, cancel_reason=(reason or "انتهت المشاركة في الجلسات الأسبوعية")[:200],
            updated_at=now)
        stamp = int(now.timestamp())
        _tell(student, "series_removed", f"أُزلت من جلسات أسبوعية: {_label(rule)}", f"مع {rule.teacher.display_name} · أُلغيت مشاركتك في الجلسات القادمة.",
              f"series:{rule.pk}:removed:{student.pk}:{stamp}", {"series": rule.pk})
        if by.pk != rule.teacher_id:
            _tell(rule.teacher, "series_participant_removed", "أُزيل طالب من جلساتك الأسبوعية", f"{student.full_name} · {_label(rule)}",
                  f"series:{rule.pk}:removed:{student.pk}:t:{stamp}", {"series": rule.pk}, link="/teacher/schedule")
    return {"bookings_cancelled": n}


def skip_occurrence(occ: SessionOccurrence, by, reason: str = "") -> None:
    """A single session of a series was cancelled: remember the date so it is never generated again."""
    if occ.series_id and occ.series_date:
        RecurringSessionException.objects.get_or_create(rule_id=occ.series_id, date=occ.series_date, slot_id=occ.series_slot_id,
                                                        defaults={"reason": reason[:200], "created_by": by})


def run_all(now=None) -> dict:
    """The hourly job: extend every active series and keep its participants booked."""
    total = {"series": 0, "created": 0, "booked": 0, "conflicts": 0}
    for rule in RecurringSessionRule.objects.filter(status=RecurringSessionRule.Status.ACTIVE).select_related("teacher"):
        try:
            r = generate(rule, now=now)
        except Exception:  # noqa: BLE001 — one series never stops the others
            log.exception("series_generate_failed", extra={"series": rule.pk})
            continue
        total["series"] += 1
        total["created"] += r["created"]
        total["booked"] += r["booked"]
        total["conflicts"] += len(r["conflicts"])
    return total
