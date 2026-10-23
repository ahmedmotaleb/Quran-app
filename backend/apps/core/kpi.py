"""Operational dashboards (PROMPT 46): academy KPIs and per-teacher workload, aggregated in the database.

Every metric comes with its definition and the numbers behind it (numerator / denominator), so nothing is shown as a
bare percentage. When the data for a ratio is empty the value is null («لا بيانات كافية»), never 0% or 100%.
Filters: date range (default the last 30 days, in the platform time zone), teacher, circle. A filter that does not
apply to a metric is listed in `not_filtered` for it.
"""
from __future__ import annotations

import csv
import io
from datetime import date, datetime, time, timedelta
from statistics import median
from zoneinfo import ZoneInfo

from django.db.models import Count, F, Q, Sum
from django.http import HttpResponse
from django.utils import timezone
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import AccountStatus, Role, TeacherAssignment, User
from apps.accounts.permissions import IsAdminRole
from apps.core.audit import audit
from apps.core.exceptions import ApiError
from apps.core.models import AppSettings, AuditEvent

REVIEW_SLA_HOURS = 48  # a recording waiting longer than this for feedback counts as overdue


def _ratio(num: int, den: int) -> dict:
    return {"value": round(num / den, 3) if den else None, "num": num, "den": den}


def parse_filters(params) -> dict:
    cfg = AppSettings.load()
    tz = ZoneInfo(cfg.default_timezone or "Africa/Cairo")
    today = timezone.now().astimezone(tz).date()
    try:
        to = date.fromisoformat(params.get("to")) if params.get("to") else today
        frm = date.fromisoformat(params.get("from")) if params.get("from") else to - timedelta(days=29)
    except ValueError:
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"from": ["تاريخ غير صالح (YYYY-MM-DD)."]}) from None
    if frm > to or (to - frm).days > 366:
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"from": ["الفترة من يوم إلى سنة كحد أقصى."]})
    def as_int(k):
        v = params.get(k)
        try:
            return int(v) if v else None
        except ValueError:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {k: ["قيمة غير صالحة."]}) from None
    t0 = datetime.combine(frm, time.min, tz)
    t1 = datetime.combine(to + timedelta(days=1), time.min, tz)
    return {"from": frm, "to": to, "t0": t0, "t1": t1, "tz": tz, "teacher": as_int("teacher"), "circle": as_int("circle")}


def _sessions(f):
    from apps.scheduling.models import SessionOccurrence

    qs = SessionOccurrence.objects.filter(starts_at__gte=f["t0"], starts_at__lt=f["t1"]).exclude(status="cancelled")
    if f["teacher"]:
        qs = qs.filter(teacher_id=f["teacher"])
    if f["circle"]:
        qs = qs.filter(circle_id=f["circle"])
    return qs


def _attendance(f, now) -> dict:
    from apps.scheduling import excuses
    from apps.scheduling.models import Booking

    bk = Booking.objects.filter(status="confirmed", occurrence__in=_sessions(f).filter(ends_at__lte=now))
    by = dict(bk.values_list("attendance").annotate(n=Count("id")))
    present, late, absent, excused = (by.get(k, 0) for k in ("present", "late", "absent", "excused"))
    marked = present + late + absent + excused
    return {"present": present, "late": late, "absent": absent, "excused": excused, "unmarked": by.get("", 0),
            "attendance_rate": _ratio(present + late, present + late + absent),
            "unexcused_absence_rate": _ratio(bk.filter(excuses.unexcused_q()).count(), marked)}


def academy_kpis(f) -> dict:
    from apps.learning.models import Assignment, AssignmentStatus, Feedback, Submission
    from apps.scheduling.models import Booking, BookingExcuse, Circle, CircleMember

    now = timezone.now()
    sessions = _sessions(f)
    seats = sessions.aggregate(cap=Sum("capacity"))["cap"] or 0
    booked = Booking.objects.filter(status="confirmed", occurrence__in=sessions).count()
    circles = Circle.objects.filter(state="published")
    if f["teacher"]:
        circles = circles.filter(teacher_id=f["teacher"])
    if f["circle"]:
        circles = circles.filter(pk=f["circle"])
    cap = circles.aggregate(c=Sum("capacity"))["c"] or 0
    members = CircleMember.objects.filter(circle__in=circles, active=True).count()
    tasks = Assignment.objects.filter(due_at__gte=f["t0"], due_at__lt=f["t1"])
    fb = Feedback.objects.filter(created_at__gte=f["t0"], created_at__lt=f["t1"])
    backlog = Submission.objects.filter(feedback__isnull=True)
    excuses_pending = BookingExcuse.objects.filter(status="pending")
    if f["teacher"]:
        tasks, fb, backlog = tasks.filter(teacher_id=f["teacher"]), fb.filter(teacher_id=f["teacher"]), backlog.filter(assignment__teacher_id=f["teacher"])
        excuses_pending = excuses_pending.filter(booking__occurrence__teacher_id=f["teacher"])
    if f["circle"]:
        excuses_pending = excuses_pending.filter(booking__occurrence__circle_id=f["circle"])
    turn = [(c - s).total_seconds() / 3600 for c, s in fb.values_list("created_at", "submission__created_at")]
    oldest = backlog.order_by("created_at").values_list("created_at", flat=True).first()
    students = User.objects.filter(role=Role.STUDENT)
    att = _attendance(f, now)
    return {
        "active_students": students.filter(status=AccountStatus.ACTIVE).count(),
        "active_teachers": User.objects.filter(role=Role.TEACHER, status=AccountStatus.ACTIVE, teacher_profile__approved_at__isnull=False).count(),
        "new_registrations": students.filter(date_joined__gte=f["t0"], date_joined__lt=f["t1"]).count(),
        "attendance": att,
        "suspended_by_absence": AuditEvent.objects.filter(action="student.auto_suspended_absence", created_at__gte=f["t0"], created_at__lt=f["t1"]).count(),
        "booking_fill_rate": _ratio(booked, seats),
        "circle_capacity_utilization": _ratio(members, cap),
        "assignment_completion": {**_ratio(tasks.filter(status=AssignmentStatus.ACCEPTED).count(), tasks.count()),
                                  "submitted_waiting": tasks.filter(status=AssignmentStatus.SUBMITTED).count()},
        "review_turnaround_hours": {"median": round(median(turn), 1) if turn else None, "reviews": len(turn)},
        "pending_teacher_approvals": User.objects.filter(role=Role.TEACHER, status=AccountStatus.ACTIVE, teacher_profile__approved_at__isnull=True).count(),
        "pending_excuses": excuses_pending.count(),
        "recording_review_backlog": {"count": backlog.count(), "oldest_hours": round((now - oldest).total_seconds() / 3600, 1) if oldest else None},
    }


def teacher_workload(f) -> list[dict]:
    from apps.learning.models import Correction, Submission
    from apps.scheduling.models import Booking, BookingExcuse, CircleMember, SessionOccurrence

    now = timezone.now()
    teachers = User.objects.filter(role=Role.TEACHER, status=AccountStatus.ACTIVE).select_related("teacher_profile").order_by("full_name")
    if f["teacher"]:
        teachers = teachers.filter(pk=f["teacher"])
    if f["circle"]:
        teachers = teachers.filter(circles__pk=f["circle"])
    week = SessionOccurrence.objects.filter(status="scheduled", starts_at__gte=now, starts_at__lt=now + timedelta(days=7)).annotate(
        n=Count("bookings", filter=Q(bookings__status="confirmed")))
    rows = []
    for t in teachers:
        mine = _sessions({**f, "teacher": t.pk})
        seats = mine.aggregate(c=Sum("capacity"))["c"] or 0
        booked = Booking.objects.filter(status="confirmed", occurrence__in=mine).count()
        upcoming = week.filter(teacher=t)
        att = _attendance({**f, "teacher": t.pk}, now)
        waiting = Submission.objects.filter(assignment__teacher=t, feedback__isnull=True)
        rows.append({
            "teacher": {"id": t.pk, "name": t.full_name, "approved": bool(getattr(t, "teacher_profile", None) and t.teacher_profile.approved_at)},
            "active_students": TeacherAssignment.objects.filter(teacher=t, active=True).count(),
            "circle_students": CircleMember.objects.filter(circle__teacher=t, active=True).values("student").distinct().count(),
            "upcoming_sessions": upcoming.filter(n__gt=0).count(),
            "available_slots": upcoming.filter(n__lt=F("capacity")).count(),
            "utilization": _ratio(booked, seats),
            "awaiting_review": waiting.count(),
            "overdue_feedback": waiting.filter(created_at__lt=now - timedelta(hours=REVIEW_SLA_HOURS)).count(),
            "pending_excuses": BookingExcuse.objects.filter(status="pending", booking__occurrence__teacher=t).count(),
            "unresolved_mistakes": Correction.objects.filter(teacher=t).exclude(status=Correction.Status.CORRECTED).count(),
            "attendance_rate": att["attendance_rate"],
            "no_show_rate": _ratio(att["absent"], att["present"] + att["late"] + att["absent"] + att["excused"]),
        })
    return rows


DEFINITIONS = {
    "active_students": "طلاب حالتهم «نشط» الآن (لا تتأثر بالفترة).",
    "active_teachers": "معلمون نشطون ومعتمدون الآن.",
    "new_registrations": "حسابات طلاب أُنشئت خلال الفترة.",
    "attendance_rate": "(حضر + متأخر) ÷ (حضر + متأخر + غاب) لجلسات انتهت خلال الفترة. غير المسجَّل والغياب بعذر لا يدخلان.",
    "unexcused_absence_rate": "غياب بدون عذر مقبول أو معلّق ÷ الحجوزات المسجَّل حضورها.",
    "suspended_by_absence": "مرات الإيقاف التلقائي بعد الغياب الثالث بدون عذر خلال الفترة.",
    "booking_fill_rate": "الحجوزات المؤكدة ÷ مجموع المقاعد في جلسات الفترة غير الملغاة.",
    "circle_capacity_utilization": "الأعضاء النشطون ÷ سعة الحلقات المنشورة الآن.",
    "assignment_completion": "مهام مستحقة خلال الفترة اعتمدها المعلم ÷ كل المهام المستحقة خلالها.",
    "review_turnaround_hours": "الوسيط بالساعات بين التسليم وتقييم المعلم، للتقييمات المكتوبة خلال الفترة.",
    "pending_teacher_approvals": "معلمون نشطون ينتظرون الاعتماد الآن.",
    "pending_excuses": "طلبات اعتذار تنتظر قرار المعلم الآن.",
    "recording_review_backlog": "تسجيلات لم تُقيَّم بعد الآن، وعمر أقدمها.",
    "utilization": "المقاعد المحجوزة ÷ المقاعد في جلسات المعلم خلال الفترة.",
    "overdue_feedback": f"تسجيلات تنتظر التقييم أكثر من {REVIEW_SLA_HOURS} ساعة.",
    "no_show_rate": "غاب ÷ كل الحجوزات المسجَّل حضورها لجلسات المعلم خلال الفترة.",
    "upcoming_sessions": "جلسات الأيام السبعة القادمة فيها حجز واحد على الأقل.",
    "available_slots": "جلسات الأيام السبعة القادمة فيها مقعد متاح.",
}
NOT_FILTERED = {"circle": ["new_registrations", "active_students", "active_teachers", "assignment_completion", "review_turnaround_hours",
                           "recording_review_backlog", "pending_teacher_approvals", "suspended_by_absence"],
                "teacher": ["new_registrations", "active_students", "active_teachers", "pending_teacher_approvals", "suspended_by_absence"]}


def _range(f) -> dict:
    return {"from": f["from"].isoformat(), "to": f["to"].isoformat(), "timezone": str(f["tz"]), "teacher": f["teacher"], "circle": f["circle"]}


class AdminKpis(APIView):
    """GET ?from&to&teacher&circle: academy KPIs (analytics.view)."""

    permission_classes = [IsAdminRole]
    admin_perm = "analytics.view"

    def get(self, request):
        f = parse_filters(request.query_params)
        return Response({"range": _range(f), "kpis": academy_kpis(f), "definitions": DEFINITIONS,
                         "not_filtered": {k: v for k, v in NOT_FILTERED.items() if f[k]}})


class AdminTeacherWorkload(APIView):
    """GET ?from&to&teacher&circle: per-teacher workload (analytics.view)."""

    permission_classes = [IsAdminRole]
    admin_perm = "analytics.view"

    def get(self, request):
        f = parse_filters(request.query_params)
        return Response({"range": _range(f), "results": teacher_workload(f), "definitions": DEFINITIONS})


class AdminTeacherWorkloadExport(APIView):
    """POST {from,to,teacher,circle}: the same table as CSV (analytics.view + exports.create), audited."""

    permission_classes = [IsAdminRole]
    admin_perm = "analytics.view"

    def post(self, request):
        from apps.accounts.admin_access import require

        require(request.user, "exports.create")
        f = parse_filters({k: str(v) for k, v in (request.data or {}).items() if v not in (None, "")})
        rows = teacher_workload(f)
        pct = lambda r: "" if r["value"] is None else f"{round(r['value'] * 100)}%"  # noqa: E731
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["المعلم", "معتمد", "طلاب مرتبطون", "طلاب الحلقات", "جلسات قادمة", "مواعيد متاحة", "نسبة الإشغال", "بانتظار التقييم",
                    f"متأخرة > {REVIEW_SLA_HOURS} ساعة", "اعتذارات معلقة", "أخطاء مفتوحة", "نسبة الحضور", "نسبة الغياب"])
        for r in rows:
            w.writerow([r["teacher"]["name"], "نعم" if r["teacher"]["approved"] else "لا", r["active_students"], r["circle_students"],
                        r["upcoming_sessions"], r["available_slots"], pct(r["utilization"]), r["awaiting_review"], r["overdue_feedback"],
                        r["pending_excuses"], r["unresolved_mistakes"], pct(r["attendance_rate"]), pct(r["no_show_rate"])])
        audit("admin.export", actor=request.user, request=request, resource="teacher_workload", mode="filter", rows=len(rows), filter=_range(f))
        resp = HttpResponse("\ufeff" + buf.getvalue(), content_type="text/csv; charset=utf-8")
        resp["Content-Disposition"] = f'attachment; filename="teacher-workload-{f["from"]}-{f["to"]}.csv"'
        return resp
