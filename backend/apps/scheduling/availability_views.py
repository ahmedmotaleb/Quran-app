"""«المواعيد → الإتاحة»: the teacher's weekly ranges, date-only changes and blocked time (availability.py computes the
bookable times from them). The same endpoints exist for admins under admin/teachers/<id>/availability… (view:
teachers.view; change: sessions.manage). Every change is audited: teacher.availability_changed (by the teacher) or
teacher.availability_admin_changed (by an admin). A blocked time's reason is never shown to students.

Times are "HH:MM" (24 h, 00:00–23:59) on the booking increment, in the academy timezone (Africa/Cairo by default);
an end earlier than or equal to the start runs past midnight («22:00 → 02:00»). Existing bookings are never changed
by any of these endpoints: only the times offered from now on.
"""
from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.db import transaction
from django.utils import timezone
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import Role, User
from apps.accounts.permissions import IsAdminRole, IsTeacher
from apps.core.audit import audit
from apps.core.exceptions import ApiError
from apps.core.models import AppSettings

from . import availability as av
from .models import AvailabilityException, AvailabilityRule, Booking

AR_DAYS = ["الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد"]  # Python weekday order
HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
E = AvailabilityException.Kind


def bad(field: str, msg: str, code: str = "invalid", status: int = 400):
    return ApiError(code, msg if code != "invalid" else "تحقق من البيانات المُدخلة.", status, {field: [msg]})


def hhmm(t: time | None) -> str | None:
    return t.strftime("%H:%M") if t else None


def parse_time(v, field: str, cfg) -> time:
    m = HHMM.match(str(v or ""))
    if not m:
        raise bad(field, "اختر وقتًا صحيحًا بين 00:00 و23:59.")
    h, mi = int(m.group(1)), int(m.group(2))
    if mi % av.increment(cfg):
        raise bad(field, f"اختر وقتًا على فواصل {av.increment(cfg)} دقيقة.")
    return time(h, mi)


def parse_range(d: dict, cfg, *, with_minutes: bool) -> tuple[time, time, int | None]:
    s, e = parse_time(d.get("start"), "start", cfg), parse_time(d.get("end"), "end", cfg)
    n = av.length(s, e)
    if n == 0:
        raise bad("end", "وقت النهاية يساوي وقت البداية. اختر فترة لها مدة.")
    minutes = None
    if with_minutes:
        try:
            minutes = int(d.get("session_minutes") or cfg.individual_minutes)
        except (TypeError, ValueError):
            minutes = 0
        if minutes not in av.durations(cfg):
            raise bad("session_minutes", "اختر مدة جلسة من المدد المسموح بها.")
        if n < minutes:
            raise bad("end", f"الفترة أقصر من مدة الجلسة ({minutes} دقيقة).")
    return s, e, minutes


def week_span(weekday: int, s: time, e: time) -> tuple[int, int]:
    return weekday * av.DAY + av.mins(s), av.length(s, e)


def week_overlap(a: tuple[int, int], b: tuple[int, int]) -> bool:
    """Ranges on the weekly circle (an overnight Saturday range reaches Sunday morning; Sunday wraps to Monday)."""
    return (b[0] - a[0]) % av.WEEK < a[1] or (a[0] - b[0]) % av.WEEK < b[1]


def check_week(teacher, weekday: int, s: time, e: time, *, exclude: set[int] = frozenset(), extra=()) -> None:
    mine = week_span(weekday, s, e)
    others = [(r.weekday, r.start_time, r.end_time) for r in AvailabilityRule.objects.filter(teacher=teacher, active=True).exclude(pk__in=exclude)]
    for wd, rs, re_ in [*others, *extra]:
        if week_overlap(mine, week_span(wd, rs, re_)):
            same = (wd, rs, re_) == (weekday, s, e)
            msg = "هذه الفترة مضافة بالفعل." if same else f"تتداخل هذه الفترة مع فترة {hhmm(rs)}–{hhmm(re_)} يوم {AR_DAYS[wd]}."
            raise ApiError("overlap", msg, 409, {"start": [msg]})


def rule_out(r: AvailabilityRule) -> dict:
    return {"id": r.pk, "weekday": r.weekday, "start": hhmm(r.start_time), "end": hhmm(r.end_time), "session_minutes": r.session_minutes,
            "overnight": av.mins(r.end_time) <= av.mins(r.start_time), "timezone": r.timezone}


def exc_out(x: AvailabilityException, *, private: bool = True) -> dict:
    out = {"id": x.pk, "date": x.date.isoformat(), "kind": x.kind, "start": hhmm(x.start_time), "end": hhmm(x.end_time),
           "session_minutes": x.session_minutes, "overnight": bool(x.start_time and x.end_time and av.mins(x.end_time) <= av.mins(x.start_time))}
    if private:
        out["reason"] = x.reason
    return out


class _Base(APIView):
    """Teacher routes act on request.user; admin routes (`tid` in the URL) on that teacher."""

    def teacher(self, request, kw) -> User:
        if "tid" not in kw:
            return request.user
        t = User.objects.filter(pk=kw["tid"], role=Role.TEACHER).exclude(status="deleted").first()
        if t is None:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        return t

    def changed(self, request, kw, teacher, op: str, **data) -> None:
        action = "teacher.availability_admin_changed" if "tid" in kw else "teacher.availability_changed"
        audit(action, actor=request.user, target=teacher, request=request, op=op, **data)


def _perm(view, request):
    return "teachers.view" if request.method in ("GET", "HEAD", "OPTIONS") else "sessions.manage"


class TeacherAvailability(_Base):
    """GET: the weekly ranges and the options (timezone, increment, session lengths, gap)."""

    def get(self, request, **kw):
        t = self.teacher(request, kw)
        cfg = AppSettings.load()
        rules = AvailabilityRule.objects.filter(teacher=t, active=True).order_by("weekday", "start_time")
        tz = av.academy_tz(cfg)
        return Response({"timezone": tz, "tz_offset": datetime.now(ZoneInfo(tz)).strftime("%z"), "increment": av.increment(cfg),
                         "durations": av.durations(cfg), "default_minutes": cfg.individual_minutes if cfg.individual_minutes in av.durations(cfg) else av.durations(cfg)[0],
                         "gap_minutes": av.gap(cfg), "rules": [rule_out(r) for r in rules]})


class TeacherAvailabilityRules(_Base):
    """POST {weekday 0=Monday…6=Sunday, start, end, session_minutes}: «إضافة فترة إتاحة»."""

    def post(self, request, **kw):
        t = self.teacher(request, kw)
        cfg = AppSettings.load()
        wd = request.data.get("weekday")
        if not isinstance(wd, int) or isinstance(wd, bool) or not 0 <= wd <= 6:
            raise bad("weekday", "اختر اليوم.")
        s, e, minutes = parse_range(request.data, cfg, with_minutes=True)
        with transaction.atomic():
            services_lock(t)
            check_week(t, wd, s, e)
            r = AvailabilityRule.objects.create(teacher=t, weekday=wd, start_time=s, end_time=e, session_minutes=minutes,
                                                timezone=av.academy_tz(cfg), valid_from=timezone.localdate())
            self.changed(request, kw, t, "range_added", weekday=wd, start=hhmm(s), end=hhmm(e), session_minutes=minutes)
        return Response(rule_out(r), status=201)


class TeacherAvailabilityRule(_Base):
    """PATCH {start, end, session_minutes} (تعديل) · DELETE (حذف). Booked sessions stay as they are."""

    def _get(self, t, rid):
        r = AvailabilityRule.objects.filter(pk=rid, teacher=t, active=True).first()
        if r is None:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        return r

    def patch(self, request, rid, **kw):
        t = self.teacher(request, kw)
        cfg = AppSettings.load()
        with transaction.atomic():
            services_lock(t)
            r = self._get(t, rid)
            data = {"start": hhmm(r.start_time), "end": hhmm(r.end_time), "session_minutes": r.session_minutes, **request.data}
            s, e, minutes = parse_range(data, cfg, with_minutes=True)
            check_week(t, r.weekday, s, e, exclude={r.pk})
            before = (hhmm(r.start_time), hhmm(r.end_time), r.session_minutes)
            r.start_time, r.end_time, r.session_minutes = s, e, minutes
            r.save(update_fields=["start_time", "end_time", "session_minutes", "updated_at"])
            self.changed(request, kw, t, "range_changed", weekday=r.weekday, before=list(before), start=hhmm(s), end=hhmm(e),
                         session_minutes=minutes)
        return Response(rule_out(r))

    def delete(self, request, rid, **kw):
        t = self.teacher(request, kw)
        with transaction.atomic():
            r = self._get(t, rid)
            self.changed(request, kw, t, "range_removed", weekday=r.weekday, start=hhmm(r.start_time), end=hhmm(r.end_time))
            r.delete()  # sessions it produced keep their time (source_rule is set to null)
        return Response(status=204)


class TeacherAvailabilityCopy(_Base):
    """POST {from_weekday, to_weekdays: [...]}: «نسخ لأيام أخرى» / «نسخ لهذا الأسبوع» — the chosen days get exactly the
    ranges of `from_weekday` (their own ranges are replaced). All or nothing: an overlap refuses the whole copy."""

    def post(self, request, **kw):
        t = self.teacher(request, kw)
        src, dst = request.data.get("from_weekday"), request.data.get("to_weekdays")
        if not isinstance(src, int) or not 0 <= src <= 6:
            raise bad("from_weekday", "اختر اليوم.")
        if not isinstance(dst, list) or not dst or not all(isinstance(x, int) and 0 <= x <= 6 and x != src for x in dst):
            raise bad("to_weekdays", "اختر يومًا واحدًا على الأقل.")
        dst = sorted(set(dst))
        cfg = AppSettings.load()
        with transaction.atomic():
            services_lock(t)
            rules = list(AvailabilityRule.objects.filter(teacher=t, active=True, weekday=src))
            keep = [(r.weekday, r.start_time, r.end_time) for r in AvailabilityRule.objects.filter(teacher=t, active=True).exclude(weekday__in=dst)]
            new = [(wd, r.start_time, r.end_time, r.session_minutes) for wd in dst for r in rules]
            for i, (wd, s, e, _) in enumerate(new):
                others = keep + [(w2, s2, e2) for j, (w2, s2, e2, _) in enumerate(new) if j != i]
                for o in others:
                    if week_overlap(week_span(wd, s, e), week_span(*o)):
                        raise ApiError("overlap", f"لا يمكن النسخ: الفترة {hhmm(s)}–{hhmm(e)} يوم {AR_DAYS[wd]} تتداخل مع فترة {hhmm(o[1])}–{hhmm(o[2])} يوم {AR_DAYS[o[0]]}.", 409)
            AvailabilityRule.objects.filter(teacher=t, active=True, weekday__in=dst).delete()
            AvailabilityRule.objects.bulk_create([AvailabilityRule(teacher=t, weekday=wd, start_time=s, end_time=e, session_minutes=m,
                                                                   timezone=av.academy_tz(cfg), valid_from=timezone.localdate()) for wd, s, e, m in new])
            self.changed(request, kw, t, "copied", from_weekday=src, to_weekdays=dst, ranges=len(rules))
        return TeacherAvailability().get(request, **kw)


class TeacherAvailabilityOverrides(_Base):
    """GET ?from=&to= (dates) · POST {date, kind: off|extra|blocked, start?, end?, session_minutes?, reason?}
    («تعديل هذا اليوم فقط»: close the date, add a range, or «حظر وقت»). Changes that date only."""

    def get(self, request, **kw):
        t = self.teacher(request, kw)
        today = timezone.localdate()
        frm = _date(request.query_params.get("from"), today)
        to = _date(request.query_params.get("to"), frm + timedelta(days=60))
        qs = AvailabilityException.objects.filter(teacher=t, date__gte=frm, date__lte=to).order_by("date", "start_time")
        return Response({"results": [exc_out(x) for x in qs]})

    def post(self, request, **kw):
        t = self.teacher(request, kw)
        cfg = AppSettings.load()
        day = _date(request.data.get("date"), None)
        if day is None:
            raise bad("date", "اختر التاريخ.")
        if day < timezone.localdate() or day > timezone.localdate() + timedelta(days=366):
            raise bad("date", "اختر تاريخًا من اليوم وحتى سنة قادمة.")
        kind = request.data.get("kind")
        if kind not in E.values:
            raise bad("kind", "اختر نوع التعديل.")
        reason = str(request.data.get("reason", "")).strip()[:200]
        with transaction.atomic():
            services_lock(t)
            if kind == E.OFF:
                x = AvailabilityException.objects.filter(teacher=t, date=day, kind=E.OFF, start_time__isnull=True).first()
                if x is None:
                    x = AvailabilityException.objects.create(teacher=t, date=day, kind=E.OFF, reason=reason, timezone=av.academy_tz(cfg))
            else:
                s, e, minutes = parse_range(request.data, cfg, with_minutes=kind == E.EXTRA)
                same = AvailabilityException.objects.filter(teacher=t, date=day, kind=kind).exclude(start_time__isnull=True)
                for o in same:
                    if av.overlaps(*_on(day, s, e), *_on(day, o.start_time, o.end_time)):
                        raise ApiError("overlap", f"تتداخل مع فترة {hhmm(o.start_time)}–{hhmm(o.end_time)} في اليوم نفسه.", 409,
                                       {"start": ["تتداخل مع فترة أخرى."]})
                x = AvailabilityException.objects.create(teacher=t, date=day, kind=kind, start_time=s, end_time=e, session_minutes=minutes,
                                                         reason=reason, timezone=av.academy_tz(cfg))
            # the reason is the teacher's own note: kept out of the audit
            self.changed(request, kw, t, f"date_{kind}", date=day.isoformat(), start=hhmm(x.start_time), end=hhmm(x.end_time))
        return Response(exc_out(x), status=201)


class TeacherAvailabilityOverride(_Base):
    def delete(self, request, oid, **kw):
        t = self.teacher(request, kw)
        x = AvailabilityException.objects.filter(pk=oid, teacher=t).first()
        if x is None:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        self.changed(request, kw, t, f"date_{x.kind}_removed", date=x.date.isoformat(), start=hhmm(x.start_time), end=hhmm(x.end_time))
        x.delete()
        return Response(status=204)


class TeacherAvailabilityDay(_Base):
    """GET ?date=YYYY-MM-DD: one day as the teacher sees it — its ranges (weekly and this-date-only), blocked time,
    a timeline of states (available / booked / unavailable / calendar conflict), the real sessions of the day with
    who is in them, and how many start times students can book."""

    def get(self, request, **kw):
        t = self.teacher(request, kw)
        cfg = AppSettings.load()
        day = _date(request.query_params.get("date"), timezone.localdate())
        tz = ZoneInfo(av.academy_tz(cfg))
        d0, d1 = av.aware(day, time(0), tz), av.aware(day + timedelta(days=1), time(0), tz)
        wins, blocks = av.windows_and_blocks(t, day, day, cfg)
        wins = [w for w in wins if av.overlaps(w.start, w.end, d0, d1)]
        sessions = sorted(av.busy(t, d0, d1), key=lambda o: o.starts_at)
        names = {}
        for b in Booking.objects.filter(occurrence__in=[o.pk for o in sessions], status=Booking.Status.CONFIRMED).select_related("student"):
            names.setdefault(b.occurrence_id, []).append(b.student.full_name)
        gb = [x for x in av.google_busy(t, d0, d1) if av.overlaps(*x, d0, d1)]
        segs = _timeline(wins, blocks, [(o.starts_at, o.ends_at) for o in sessions], gb, d0, d1)
        exc = AvailabilityException.objects.filter(teacher=t, date=day).order_by("start_time")
        rules = AvailabilityRule.objects.filter(teacher=t, active=True, weekday=day.weekday()).order_by("start_time")
        bookable = av.compute(t, d0, d1 - timedelta(minutes=1), cfg=cfg)
        return Response({
            "date": day.isoformat(), "weekday": day.weekday(), "timezone": str(tz),
            "closed": any(x.kind == E.OFF and x.start_time is None for x in exc),
            "weekly": [rule_out(r) for r in rules], "overrides": [exc_out(x) for x in exc],
            "timeline": segs, "bookable_starts": len(bookable),
            "google_conflicts": [{"start": a.isoformat(), "end": b.isoformat()} for a, b in gb],
            "sessions": [{"id": o.pk, "starts_at": o.starts_at.isoformat(), "ends_at": o.ends_at.isoformat(), "kind": o.kind, "status": o.status,
                          "circle_name": o.circle.name if o.circle_id else None, "students": names.get(o.pk, []), "topic": o.topic, "title": o.title}
                         for o in sessions],
        })


def _timeline(wins, blocks, sessions, gbusy, d0, d1) -> list[dict]:
    """States over the day inside the availability windows (and every session even outside them), in order:
    booked > unavailable (blocked) > calendar conflict > available."""
    spans = [(max(w.start, d0), min(w.end, d1)) for w in wins] + [(max(a, d0), min(b, d1)) for a, b in sessions]
    points = sorted({p for a, b in spans for p in (a, b)} | {p for a, b in [*blocks, *gbusy] for p in (max(a, d0), min(b, d1))})
    out: list[dict] = []
    for a, b in zip(points, points[1:]):
        if a >= b:
            continue
        in_win = any(w0 <= a and b <= w1 for w0, w1 in spans[:len(wins)])
        state = ("booked" if any(av.overlaps(a, b, s, e) for s, e in sessions)
                 else None if not in_win
                 else "unavailable" if any(av.overlaps(a, b, s, e) for s, e in blocks)
                 else "calendar" if any(av.overlaps(a, b, s, e) for s, e in gbusy)
                 else "available")
        if state is None:
            continue
        if out and out[-1]["state"] == state and out[-1]["end"] == a.isoformat():
            out[-1]["end"] = b.isoformat()
        else:
            out.append({"start": a.isoformat(), "end": b.isoformat(), "state": state})
    return out


def _date(v, default):
    try:
        return date.fromisoformat(str(v)) if v else default
    except ValueError:
        raise bad("date", "تاريخ غير صالح.") from None


def _on(day: date, s: time, e: time):
    base = datetime(2000, 1, 1)
    a = base + timedelta(days=(day - date(2000, 1, 1)).days, minutes=av.mins(s))
    return a, a + timedelta(minutes=av.length(s, e))


def services_lock(t) -> None:
    """Availability edits for one teacher are serialised (two tabs cannot save overlapping ranges)."""
    from .services import _lock_teacher

    _lock_teacher(t.pk)


# ---- routes ---------------------------------------------------------------------------------------------------
def _teacher_view(cls):
    return type(f"Own{cls.__name__}", (cls,), {"permission_classes": [IsTeacher]})


def _admin_view(cls):
    return type(f"Admin{cls.__name__}", (cls,), {"permission_classes": [IsAdminRole], "admin_perm": staticmethod(_perm)})


VIEWS = [("", TeacherAvailability), ("/rules", TeacherAvailabilityRules), ("/rules/<int:rid>", TeacherAvailabilityRule),
         ("/copy", TeacherAvailabilityCopy), ("/overrides", TeacherAvailabilityOverrides),
         ("/overrides/<int:oid>", TeacherAvailabilityOverride), ("/day", TeacherAvailabilityDay)]


def urls():
    from django.urls import path

    return ([path(f"teacher/availability{suffix}", _teacher_view(cls).as_view()) for suffix, cls in VIEWS]
            + [path(f"admin/teachers/<int:tid>/availability{suffix}", _admin_view(cls).as_view()) for suffix, cls in VIEWS])
