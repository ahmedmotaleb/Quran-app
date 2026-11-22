"""«جلسات الأسبوع» for the admin portal (owner request, 22 Nov 2026): every session of one week (Saturday to Friday,
Cairo time), what happened in it, and totals per teacher.

GET admin/sessions/week?start=YYYY-MM-DD&teacher=<id>&result=<r>   (permission sessions.view)
- `start`: any date in the wanted week (default: this week); the week runs Saturday 00:00 → next Saturday 00:00 in
  Africa/Cairo, as the admin portal shows times.
- Sessions listed: every session in the week that had students (a booking, confirmed or later cancelled), and every
  session a teacher created for chosen students or a weekly series made, even before anyone joined. Open booking
  times nobody took are not sessions and are left out.
- `result` of each session, from PostgreSQL:
    held        «انعقدت»               ended, at least one student marked present or late
    absent      «غياب الجميع»           ended, every student marked absent / excused
    unmarked    «لم يُسجَّل الحضور»      ended, students booked, attendance not (fully) recorded and nobody present
    empty       «بلا طلاب»             ended with no confirmed student
    in_progress «جارية الآن»
    upcoming    «قادمة»
    cancelled   «ملغاة»
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.db.models import Prefetch, Q
from django.utils import timezone
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.permissions import IsAdminRole
from apps.core.exceptions import ApiError

from .models import Booking, SessionOccurrence

CAIRO = ZoneInfo("Africa/Cairo")
RESULTS = {"held": "انعقدت", "absent": "غياب الجميع", "unmarked": "لم يُسجَّل الحضور", "empty": "بلا طلاب",
           "in_progress": "جارية الآن", "upcoming": "قادمة", "cancelled": "ملغاة"}
TOPICS = dict(SessionOccurrence.Topic.choices)


def week_bounds(any_day: date) -> tuple[date, datetime, datetime]:
    """(Saturday, start instant, end instant) of the Saturday-to-Friday week containing `any_day`, in Cairo."""
    sat = any_day - timedelta(days=(any_day.weekday() - 5) % 7)          # Python: Monday 0 … Saturday 5
    start = datetime.combine(sat, time(0), CAIRO)
    end = datetime.combine(sat + timedelta(days=7), time(0), CAIRO)    # DST-safe: each end is local midnight
    return sat, start, end


def result_of(o: SessionOccurrence, booked: list[Booking], now: datetime) -> str:
    if o.status == SessionOccurrence.Status.CANCELLED:
        return "cancelled"
    if o.starts_at > now:
        return "upcoming"
    if o.ends_at > now:
        return "in_progress"
    if not booked:
        return "empty"
    marks = [b.attendance for b in booked]
    if any(a in ("present", "late") for a in marks):
        return "held"
    if all(a in ("absent", "excused") for a in marks):
        return "absent"
    return "unmarked"


class AdminWeekSessions(APIView):
    permission_classes = [IsAdminRole]
    admin_perm = "sessions.view"

    def get(self, request):
        p = request.query_params
        try:
            day = date.fromisoformat(p["start"]) if p.get("start") else timezone.now().astimezone(CAIRO).date()
        except ValueError:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"start": ["تاريخ غير صالح."]}) from None
        sat, start, end = week_bounds(day)
        now = timezone.now()
        qs = (SessionOccurrence.objects.filter(starts_at__gte=start, starts_at__lt=end)
              .filter(Q(bookings__isnull=False) | Q(series__isnull=False) | ~Q(creation_key="") | Q(circle__isnull=False))
              .distinct().select_related("teacher", "circle", "series")
              .prefetch_related(Prefetch("bookings", queryset=Booking.objects.select_related("student").order_by("student__full_name")))
              .order_by("starts_at"))
        if str(p.get("teacher", "")).isdigit():
            qs = qs.filter(teacher_id=int(p["teacher"]))
        want = p.get("result") or ""
        rows, totals, att_total = [], Counter(), Counter()
        teachers: dict[int, dict] = defaultdict(lambda: {"sessions": 0, "held": 0, "minutes": 0, "present": 0, "absent": 0, "unmarked": 0, "cancelled": 0})
        for o in qs:
            booked = [b for b in o.bookings.all() if b.status == Booking.Status.CONFIRMED]
            res = result_of(o, booked, now)
            att = Counter((b.attendance or "unmarked") for b in booked)
            minutes = int((o.ends_at - o.starts_at).total_seconds() // 60)
            t = teachers[o.teacher_id]
            t.update(name=o.teacher.display_name, id=o.teacher_id)
            t["sessions"] += 1
            t["cancelled"] += res == "cancelled"
            if res == "held":
                t["held"] += 1
                t["minutes"] += minutes
            t["present"] += att["present"] + att["late"]
            t["absent"] += att["absent"]
            t["unmarked"] += res == "unmarked"
            totals[res] += 1
            if res not in ("cancelled", "upcoming"):
                att_total.update(att)
            if want and res != want:
                continue
            rows.append({
                "id": o.pk, "starts_at": o.starts_at.isoformat(), "ends_at": o.ends_at.isoformat(), "minutes": minutes,
                "teacher": {"id": o.teacher_id, "name": o.teacher.display_name}, "kind": o.kind,
                "kind_label": SessionOccurrence.Kind(o.kind).label, "topic": TOPICS.get(o.topic, "") if o.topic else "", "title": o.title,
                "circle": o.circle.name if o.circle_id else None, "weekly": o.series_id is not None,
                "result": res, "result_label": RESULTS[res], "has_link": bool(o.meeting_url),
                "students": [{"id": b.student_id, "name": b.student.full_name, "attendance": b.attendance} for b in booked],
                "attendance": {k: att[k] for k in ("present", "late", "absent", "excused", "unmarked")},
            })
        return Response({
            "week_start": sat.isoformat(), "week_end": (sat + timedelta(days=6)).isoformat(),
            "prev": (sat - timedelta(days=7)).isoformat(), "next": (sat + timedelta(days=7)).isoformat(),
            "is_current": start <= now < end, "timezone": "Africa/Cairo",
            "summary": {"sessions": sum(totals.values()), **{k: totals[k] for k in RESULTS},
                        "students_present": att_total["present"] + att_total["late"], "students_absent": att_total["absent"],
                        "students_excused": att_total["excused"], "held_minutes": sum(x["minutes"] for x in teachers.values())},
            "teachers": sorted(teachers.values(), key=lambda x: (-x["held"], x["name"])),
            "results": rows,
        })
