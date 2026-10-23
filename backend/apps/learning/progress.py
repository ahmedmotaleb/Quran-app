"""
One authoritative progress calculation (pack prompt 11). Student, teacher, parent and admin views all call
`student_progress`, so the same learner shows the same numbers everywhere.

Metric definitions (also returned in the payload as `rules`, so screens can explain them):
- Memorization (حفظ): the set of distinct ayahs in the learner's hifz assignments vs the distinct ayahs in hifz
  assignments the teacher ACCEPTED. Ranges are unioned per surah, so repeated submissions, needs-repeat cycles
  and overlapping assignments never count an ayah twice. All-time (not limited by the date range).
- Review (مراجعة): review assignments not yet accepted whose due date (learner's local date) is today = due today;
  before today = overdue; accepted within the range = completed.
- Scores: teacher feedback within the range, oldest first, each with the three 1–5 scores; averages over the range.
- Attendance: sessions that started within the range and already began. Rate = (present + late) /
  (present + late + absent). Excused and not-yet-marked sessions are shown but excluded from the denominator.
- Practice: submissions within the range: count, minutes recorded, and how many the teacher has reviewed.
- Lessons: lessons marked complete within the range (self-reported; not evidence of mastery).
- Quizzes: submitted/graded attempts within the range and their mean objective percentage.
- Streak: consecutive local days, ending today or yesterday, with at least one recording submitted or lesson
  completed. A day without either ends the streak.
All dates are bucketed in the learner's own IANA timezone.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.db.models import Avg, Count, F, Q, Sum, Window
from django.db.models.functions import RowNumber
from django.utils import timezone

from apps.assessments.models import Attempt
from apps.scheduling.models import Booking

from .models import Assignment, AssignmentStatus, AssignmentType, Feedback, LessonCompletion, Submission

RULES = {
    "memorization": "عدد الآيات المختلفة في مهام الحفظ التي اعتمدها المعلم من مجموع الآيات المختلفة المكلَّف بها؛ لا تُحسب الآية مرتين.",
    "review": "مستحقة اليوم: مهام مراجعة لم تُعتمد وموعدها اليوم. متأخرة: موعدها قبل اليوم. مكتملة: اعتُمدت خلال الفترة.",
    "attendance": "نسبة الحضور = (حضر + متأخر) ÷ (حضر + متأخر + غاب). الغياب بعذر وغير المسجَّل لا يدخلان في النسبة.",
    "streak": "أيام متتالية (حتى اليوم أو أمس) سُلِّم فيها تسجيل أو أُكمل فيها درس.",
}


def _ayahs(rows) -> set[tuple[int, int]]:
    out: set[tuple[int, int]] = set()
    for s, a, b in rows:
        out.update((s, n) for n in range(a, b + 1))
    return out


def local_range(tz: ZoneInfo, start: date | None, end: date | None, default_days: int = 30) -> tuple[date, date, datetime, datetime]:
    today = timezone.now().astimezone(tz).date()
    end = end or today
    start = start or end - timedelta(days=default_days - 1)
    return start, end, datetime.combine(start, time.min, tz), datetime.combine(end + timedelta(days=1), time.min, tz)


def student_progress(student, start: date | None = None, end: date | None = None) -> dict:
    tz = ZoneInfo(student.timezone or "Africa/Cairo")
    start, end, t0, t1 = local_range(tz, start, end)
    now = timezone.now()
    today = now.astimezone(tz).date()
    day0 = datetime.combine(today, time.min, tz)

    hifz = Assignment.objects.filter(student=student, kind=AssignmentType.HIFZ)
    assigned = _ayahs(hifz.values_list("surah", "ayah_from", "ayah_to"))
    accepted = _ayahs(hifz.filter(status=AssignmentStatus.ACCEPTED).values_list("surah", "ayah_from", "ayah_to"))

    rev = Assignment.objects.filter(student=student, kind=AssignmentType.REVIEW)
    open_rev = rev.exclude(status=AssignmentStatus.ACCEPTED)
    review = {
        "due_today": open_rev.filter(due_at__gte=day0, due_at__lt=day0 + timedelta(days=1)).count(),
        "overdue": open_rev.filter(due_at__lt=day0).count(),
        "completed": Feedback.objects.filter(submission__student=student, submission__assignment__kind=AssignmentType.REVIEW,
                                             decision=Feedback.Decision.ACCEPT, created_at__gte=t0, created_at__lt=t1).count(),
    }

    fb = list(Feedback.objects.filter(submission__student=student, created_at__gte=t0, created_at__lt=t1)
              .select_related("submission__assignment").order_by("created_at"))
    scores = {
        "points": [{"date": f.created_at.astimezone(tz).date().isoformat(), "hifz": f.score_hifz, "tajweed": f.score_tajweed,
                    "fluency": f.score_fluency, "decision": f.decision, "assignment": f.submission.assignment.title} for f in fb],
        "avg": {k: round(sum(getattr(f, f"score_{k}") for f in fb) / len(fb), 2) if fb else None for k in ("hifz", "tajweed", "fluency")},
        "needs_repeat": sum(1 for f in fb if f.decision == Feedback.Decision.REPEAT),
    }
    last = Feedback.objects.filter(submission__student=student).select_related("submission__assignment", "teacher").order_by("-created_at").first()
    latest_feedback = None if last is None else {
        "date": last.created_at.isoformat(), "teacher": last.teacher.full_name, "assignment": last.submission.assignment.title,
        "decision": last.decision, "general": last.general, "next_step": last.next_step, "needs_review": last.needs_review,
        "scores": {"hifz": last.score_hifz, "tajweed": last.score_tajweed, "fluency": last.score_fluency},
    }

    bk = Booking.objects.filter(student=student, status=Booking.Status.CONFIRMED, occurrence__starts_at__gte=t0,
                                occurrence__starts_at__lt=min(t1, now))
    att = {k: 0 for k in ("present", "late", "absent", "excused", "unmarked")}
    for a in bk.values_list("attendance", flat=True):
        att[a or "unmarked"] += 1
    denom = att["present"] + att["late"] + att["absent"]
    attendance = {**att, "sessions": sum(att.values()), "rate": round((att["present"] + att["late"]) / denom, 3) if denom else None}

    subs = Submission.objects.filter(student=student, created_at__gte=t0, created_at__lt=t1)
    agg = subs.aggregate(n=Count("id"), sec=Sum("duration_seconds"), reviewed=Count("feedback"))
    practice = {"submissions": agg["n"], "minutes": round((agg["sec"] or 0) / 60, 1), "reviewed": agg["reviewed"]}

    attempts = Attempt.objects.filter(student=student, submitted_at__gte=t0, submitted_at__lt=t1).exclude(status=Attempt.Status.IN_PROGRESS)
    pct = [a.objective_score / a.objective_max for a in attempts if a.objective_max]
    learning = {
        "lessons_completed": LessonCompletion.objects.filter(student=student, completed_at__gte=t0, completed_at__lt=t1).count(),
        "quiz_attempts": attempts.count(), "quiz_avg_pct": round(100 * sum(pct) / len(pct), 1) if pct else None,
    }

    active_days = {d.astimezone(tz).date() for d in Submission.objects.filter(student=student, created_at__gte=day0 - timedelta(days=400))
                   .values_list("created_at", flat=True)}
    active_days |= {d.astimezone(tz).date() for d in LessonCompletion.objects.filter(student=student, completed_at__gte=day0 - timedelta(days=400))
                    .values_list("completed_at", flat=True)}
    streak, d = 0, today if today in active_days else today - timedelta(days=1)
    while d in active_days:
        streak += 1
        d -= timedelta(days=1)

    tasks = Assignment.objects.filter(student=student)
    return {
        "student": {"id": student.id, "name": student.full_name, "timezone": str(tz)},
        "range": {"from": start.isoformat(), "to": end.isoformat()},
        "memorization": {"assigned_ayahs": len(assigned), "accepted_ayahs": len(accepted & assigned) if assigned else len(accepted),
                         "pct": round(100 * len(accepted & assigned) / len(assigned), 1) if assigned else None},
        "review": review,
        "scores": scores,
        "latest_feedback": latest_feedback,
        "attendance": attendance,
        "practice": practice,
        "learning": learning,
        "assignments": {"open": tasks.exclude(status=AssignmentStatus.ACCEPTED).count(),
                        "overdue": tasks.filter(due_at__lt=now).exclude(status__in=[AssignmentStatus.ACCEPTED, AssignmentStatus.SUBMITTED]).count(),
                        "awaiting_review": tasks.filter(status=AssignmentStatus.SUBMITTED).count(),
                        "accepted_in_range": Feedback.objects.filter(submission__student=student, decision=Feedback.Decision.ACCEPT,
                                                                     created_at__gte=t0, created_at__lt=t1).count()},
        "streak_days": streak,
        "rules": RULES,
    }


def admin_summary(start: date | None = None, end: date | None = None) -> dict:
    """Platform totals only (no per-learner data)."""
    tz = ZoneInfo("Africa/Cairo")
    start, end, t0, t1 = local_range(tz, start, end)
    now = timezone.now()
    bk = Booking.objects.filter(status=Booking.Status.CONFIRMED, occurrence__starts_at__gte=t0, occurrence__starts_at__lt=min(t1, now))
    att = dict(bk.values_list("attendance").annotate(n=Count("id")))
    denom = att.get("present", 0) + att.get("late", 0) + att.get("absent", 0)
    subs = Submission.objects.filter(created_at__gte=t0, created_at__lt=t1)
    return {
        "range": {"from": start.isoformat(), "to": end.isoformat()},
        "submissions": subs.count(), "minutes": round((subs.aggregate(s=Sum("duration_seconds"))["s"] or 0) / 60, 1),
        "feedback": Feedback.objects.filter(created_at__gte=t0, created_at__lt=t1).count(),
        "accepted": Feedback.objects.filter(created_at__gte=t0, created_at__lt=t1, decision=Feedback.Decision.ACCEPT).count(),
        "awaiting_review": Assignment.objects.filter(status=AssignmentStatus.SUBMITTED).count(),
        "sessions_held": bk.count(),
        "attendance_rate": round((att.get("present", 0) + att.get("late", 0)) / denom, 3) if denom else None,
        "lessons_completed": LessonCompletion.objects.filter(completed_at__gte=t0, completed_at__lt=t1).count(),
        "avg_scores": Feedback.objects.filter(created_at__gte=t0, created_at__lt=t1).aggregate(
            hifz=Avg("score_hifz"), tajweed=Avg("score_tajweed"), fluency=Avg("score_fluency")),
        "rules": RULES,
    }


# ---- API ------------------------------------------------------------------------------
from rest_framework.response import Response  # noqa: E402
from rest_framework.views import APIView  # noqa: E402

from apps.accounts.models import User  # noqa: E402
from apps.accounts.permissions import (  # noqa: E402
    IsAdminRole, IsParent, IsStudent, IsTeacher, assigned_student_ids, linked_child_ids,
)
from apps.core.exceptions import ApiError  # noqa: E402

NOT_FOUND = ApiError("not_found", "العنصر المطلوب غير موجود.", 404)


def _dates(request) -> tuple[date | None, date | None]:
    out = []
    for k in ("from", "to"):
        v = request.query_params.get(k)
        try:
            out.append(date.fromisoformat(v) if v else None)
        except ValueError:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {k: ["تاريخ غير صالح (YYYY-MM-DD)."]}) from None
    if out[0] and out[1] and out[0] > out[1]:
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"from": ["البداية بعد النهاية."]})
    if out[0] and out[1] and (out[1] - out[0]).days > 366:
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"from": ["أقصى مدة سنة واحدة."]})
    return out[0], out[1]


class MyProgress(APIView):
    permission_classes = [IsStudent]

    def get(self, request):
        return Response(student_progress(request.user, *_dates(request)))


class TeacherStudentProgress(APIView):
    """Only students currently assigned to the teacher; anyone else is a 404 (no probing)."""

    permission_classes = [IsTeacher]

    def get(self, request, pk):
        if not assigned_student_ids(request.user).filter(student_id=pk).exists():
            raise NOT_FOUND
        return Response(student_progress(User.objects.get(pk=pk), *_dates(request)))


class ChildProgress(APIView):
    """Verified, active guardian links only. Contains no audio or media links."""

    permission_classes = [IsParent]

    def get(self, request, pk):
        if not linked_child_ids(request.user).filter(student_id=pk).exists():
            raise NOT_FOUND
        return Response(student_progress(User.objects.get(pk=pk), *_dates(request)))


class AdminProgressSummary(APIView):
    admin_perm = "analytics.view"
    permission_classes = [IsAdminRole]

    def get(self, request):
        return Response(admin_summary(*_dates(request)))


def weekly_summary(parent) -> dict:
    """The parent's last 7 days per linked child; sent weekly by `parent_weekly_reports` and shown on demand."""
    from apps.accounts.models import AccountStatus

    ids = linked_child_ids(parent).values_list("student_id", flat=True)
    kids = User.objects.filter(pk__in=ids, status=AccountStatus.ACTIVE).order_by("full_name")
    tz = ZoneInfo(parent.timezone or "Africa/Cairo")
    end = timezone.now().astimezone(tz).date()
    start = end - timedelta(days=6)
    out = []
    for k in kids:
        p = student_progress(k, start, end)
        out.append({"child": p["student"], "accepted_ayahs_total": p["memorization"]["accepted_ayahs"],
                    "submissions": p["practice"]["submissions"], "minutes": p["practice"]["minutes"],
                    "sessions": p["attendance"]["sessions"], "attendance_rate": p["attendance"]["rate"],
                    "reviews_overdue": p["review"]["overdue"], "assignments_overdue": p["assignments"]["overdue"],
                    # Teacher feedback: decision and the next step only (never the free-text comment or audio).
                    "latest_feedback": p["latest_feedback"] and {k2: p["latest_feedback"][k2] for k2 in ("date", "assignment", "decision", "next_step")},
                    **_week_extras(k, start, end, tz, p)})
    return {"week": {"from": start.isoformat(), "to": end.isoformat()}, "children": out,
            "definitions": WEEKLY_DEFINITIONS}


# Shown with the report so every number is explained (no composite score).
WEEKLY_DEFINITIONS = {
    "accepted_ayahs_total": "آيات حفظ قبلها المعلم خلال الأيام السبعة.",
    "reviews_completed": "مهام مراجعة قيّمها المعلم خلال الأيام السبعة.",
    "attendance_rate": "(حضر + متأخر) ÷ (حضر + متأخر + غاب). الغياب بعذر لا يدخل في النسبة.",
    "absences": "غياب بعذر مقبول، وغياب بدون عذر (يُحتسب في قاعدة الإيقاف).",
    "mistakes": "نقاط المراجعة التي سجّلها المعلم هذا الأسبوع مقارنة بالأسبوع السابق، والمفتوح منها حتى الآن.",
    "upcoming": "الجلسات المؤكدة في الأيام السبعة القادمة.",
    "targets": "المهام المفتوحة المستحقة في الأيام السبعة القادمة.",
}


def _week_extras(k, start, end, tz, p) -> dict:
    """The rest of the weekly report: reviews, excused/unexcused absences, mistake trend, next week's sessions and targets."""
    from apps.scheduling import excuses
    from apps.scheduling.models import Booking, BookingExcuse

    from .models import Correction

    t0 = datetime.combine(start, time.min, tz)
    t1 = datetime.combine(end + timedelta(days=1), time.min, tz)
    now = timezone.now()
    week_bk = Booking.objects.filter(student=k, status=Booking.Status.CONFIRMED, occurrence__starts_at__gte=t0, occurrence__starts_at__lt=t1)
    approved = BookingExcuse.objects.filter(booking__in=week_bk, status=BookingExcuse.Status.APPROVED).count()
    unexcused = week_bk.filter(excuses.unexcused_q()).count()
    new_now = Correction.objects.filter(student=k, created_at__gte=t0, created_at__lt=t1)
    new_before = Correction.objects.filter(student=k, created_at__gte=t0 - timedelta(days=7), created_at__lt=t0).count()
    top = list(new_now.values("category").annotate(n=Count("id")).order_by("-n", "category")[:2])
    labels = dict(Correction.Category.choices)
    upcoming = (Booking.objects.filter(student=k, status=Booking.Status.CONFIRMED, occurrence__status="scheduled",
                                       occurrence__starts_at__gte=now, occurrence__starts_at__lt=now + timedelta(days=7))
                .select_related("occurrence__teacher").order_by("occurrence__starts_at"))
    targets = (Assignment.objects.filter(student=k, due_at__gte=now, due_at__lt=now + timedelta(days=7))
               .exclude(status__in=[AssignmentStatus.ACCEPTED, AssignmentStatus.SUBMITTED]).order_by("due_at"))
    return {
        "reviews_completed": p["review"]["completed"],
        "absences": {"excused_approved": approved, "unexcused": unexcused},
        "mistakes": {"new_this_week": new_now.count(), "new_previous_week": new_before,
                     "open": Correction.objects.filter(student=k).exclude(status=Correction.Status.CORRECTED).count(),
                     "top_categories": [{"category": t["category"], "label": labels.get(t["category"], t["category"]), "count": t["n"]} for t in top]},
        "upcoming_sessions": [{"starts_at": b.occurrence.starts_at.isoformat(), "teacher": b.occurrence.teacher.full_name} for b in upcoming[:5]],
        "targets": [{"title": a.title, "kind": a.kind, "surah": a.surah, "ayah_from": a.ayah_from, "ayah_to": a.ayah_to,
                     "due_at": a.due_at.isoformat()} for a in targets[:5]],
    }


class ParentWeeklySummary(APIView):
    permission_classes = [IsParent]

    def get(self, request):
        return Response(weekly_summary(request.user))


# ---- Teacher dashboard signals (pack prompt 13) -----------------------------------------
def teacher_dashboard(teacher) -> dict:
    """Observable signals with dates for the teacher's assigned students only. No hidden scoring or labels."""
    now = timezone.now()
    tz = ZoneInfo(teacher.timezone or "Africa/Cairo")
    sids = list(assigned_student_ids(teacher).values_list("student_id", flat=True))
    pending = (Submission.objects.filter(student_id__in=sids, assignment__teacher=teacher, feedback__isnull=True)
               .select_related("student", "assignment").order_by("created_at"))
    waiting = [{"submission": s.id, "assignment": s.assignment_id, "student": {"id": s.student_id, "name": s.student.full_name},
                "title": s.assignment.title, "submitted_at": s.created_at.isoformat(),
                "age_hours": round((now - s.created_at).total_seconds() / 3600, 1)} for s in pending[:50]]
    overdue = (Assignment.objects.filter(student_id__in=sids, teacher=teacher, due_at__lt=now)
               .exclude(status__in=[AssignmentStatus.ACCEPTED, AssignmentStatus.SUBMITTED]).select_related("student").order_by("due_at"))
    overdue_l = [{"assignment": a.id, "student": {"id": a.student_id, "name": a.student.full_name}, "title": a.title, "kind": a.kind,
                  "due_at": a.due_at.isoformat(), "days_late": (now - a.due_at).days} for a in overdue[:50]]
    since = now - timedelta(days=30)
    repeats = (Feedback.objects.filter(submission__student_id__in=sids, decision=Feedback.Decision.REPEAT, created_at__gte=since)
               .values("submission__student_id", "submission__student__full_name").annotate(n=Count("id")).filter(n__gte=2))
    repeat_l = [{"student": {"id": r["submission__student_id"], "name": r["submission__student__full_name"]}, "needs_repeat_30d": r["n"]} for r in repeats]
    # Each student's six latest scores in one query (a per-student loop made this endpoint grow with class size).
    latest = (Feedback.objects.filter(submission__student_id__in=sids)
              .annotate(rn=Window(RowNumber(), partition_by=F("submission__student_id"), order_by=F("created_at").desc()))
              .filter(rn__lte=6).order_by("submission__student_id", "rn")
              .values_list("submission__student_id", "submission__student__full_name", "score_hifz", "score_tajweed", "score_fluency", "created_at"))
    by_student: dict[int, list] = {}
    for row in latest:
        by_student.setdefault(row[0], []).append(row)
    falling = []
    for sid in sids:
        sc = by_student.get(sid, [])
        if len(sc) == 6:
            recent = sum(sum(x[2:5]) for x in sc[:3]) / 9
            before = sum(sum(x[2:5]) for x in sc[3:]) / 9
            if before - recent >= 1:
                falling.append({"student": {"id": sid, "name": sc[0][1]}, "recent_avg": round(recent, 2),
                                "previous_avg": round(before, 2), "last_feedback": sc[0][5].isoformat()})
    day0 = datetime.combine(now.astimezone(tz).date(), time.min, tz)
    today = (Booking.objects.filter(occurrence__teacher=teacher, status=Booking.Status.CONFIRMED,
                                    occurrence__starts_at__gte=day0, occurrence__starts_at__lt=day0 + timedelta(days=1))
             .select_related("student", "occurrence").order_by("occurrence__starts_at"))
    today_l = [{"booking": b.id, "student": {"id": b.student_id, "name": b.student.full_name}, "starts_at": b.occurrence.starts_at.isoformat(),
                "attendance": b.attendance} for b in today]
    return {"awaiting_review": waiting, "overdue": overdue_l, "repeated_needs_repeat": repeat_l, "falling_scores": falling,
            "today": today_l, "students": len(sids),
            "rules": {"falling_scores": "متوسط آخر 3 تقييمات أقل بدرجة أو أكثر من متوسط الثلاثة التي قبلها.",
                      "repeated_needs_repeat": "طلبتَ الإعادة مرتين أو أكثر خلال آخر 30 يومًا."}}


class TeacherDashboard(APIView):
    permission_classes = [IsTeacher]

    def get(self, request):
        return Response(teacher_dashboard(request.user))


# ---- Today plan (pack prompt 16) ---------------------------------------------------------
TODAY_RULES = [
    "1) واجبات المعلم المتأخرة أولًا (المراجعة قبل غيرها، الأقدم أولًا).",
    "2) المراجعات المستحقة اليوم.",
    "3) واجبات الحفظ والتجويد المستحقة اليوم، ثم ما طلب المعلم إعادته.",
    "4) جلسات اليوم بترتيب الوقت.",
    "5) اقتراح: الدرس التالي غير المكتمل، والاختبارات المفتوحة التي لم تُحاوَل.",
    "ما أُنجز اليوم يبقى ظاهرًا مع علامة الإنجاز ولا يُحسب مرتين. المدة التقديرية تظهر فقط إن حدّدها المعلم أو الدرس أو الاختبار.",
]


def today_plan(student) -> dict:
    from apps.assessments.models import Attempt
    from apps.assessments.services import open_tests

    from . import reviews
    from .models import Lesson, PublishState

    reviews.ensure_due(student)
    tz = ZoneInfo(student.timezone or "Africa/Cairo")
    now = timezone.now()
    today = now.astimezone(tz).date()
    d0 = datetime.combine(today, time.min, tz)
    d1 = d0 + timedelta(days=1)
    items: list[dict] = []

    def add(prio, kind, title, ref, due=None, state="todo", reason="", minutes=None, sub=""):
        items.append({"priority": prio, "kind": kind, "title": title, "ref": ref, "due": due.isoformat() if due else None,
                      "state": state, "reason": reason, "est_minutes": minutes, "subtitle": sub})

    tasks = Assignment.objects.filter(student=student).select_related("teacher")
    for t in tasks.exclude(status=AssignmentStatus.ACCEPTED):
        rng = f"سورة {t.surah}: {t.ayah_from}–{t.ayah_to}"
        if t.status == AssignmentStatus.SUBMITTED:
            if Submission.objects.filter(assignment=t, created_at__gte=d0).exists():
                add(9, t.kind, t.title, t.id, t.due_at, "done", "سُلِّم اليوم وينتظر المعلم", sub=rng)
            continue
        if t.due_at < d0:
            add(1, t.kind, t.title, t.id, t.due_at, reason="متأخر", sub=rng)
        elif t.due_at < d1:
            add(2 if t.kind == AssignmentType.REVIEW else 3, t.kind, t.title, t.id, t.due_at, reason="مستحق اليوم", sub=rng)
        elif t.status == AssignmentStatus.NEEDS_REPEAT:
            add(3, t.kind, t.title, t.id, t.due_at, reason="طلب المعلم الإعادة", sub=rng)
    for f in Feedback.objects.filter(submission__student=student, decision=Feedback.Decision.ACCEPT, created_at__gte=d0).select_related("submission__assignment"):
        a = f.submission.assignment
        add(9, a.kind, a.title, a.id, a.due_at, "done", "اعتمده المعلم اليوم", sub=f"سورة {a.surah}: {a.ayah_from}–{a.ayah_to}")
    for b in Booking.objects.filter(student=student, status=Booking.Status.CONFIRMED, occurrence__starts_at__gte=d0,
                                    occurrence__starts_at__lt=d1).select_related("occurrence__teacher").order_by("occurrence__starts_at"):
        o = b.occurrence
        ended = o.ends_at <= now
        add(9 if ended else 4, "session", f"جلسة مع {o.teacher.full_name}", b.id, o.starts_at, "done" if ended else "todo",
            "انتهت" if ended else "اليوم", int((o.ends_at - o.starts_at).total_seconds() // 60))
    done_lessons = set(LessonCompletion.objects.filter(student=student).values_list("lesson_id", flat=True))
    for lc in LessonCompletion.objects.filter(student=student, completed_at__gte=d0).select_related("lesson"):
        add(9, "lesson", lc.lesson.title, lc.lesson_id, state="done", reason="أكملته اليوم", minutes=lc.lesson.duration_minutes)
    from .views import _published_lessons

    started_courses = Lesson.objects.filter(pk__in=done_lessons).values("course_id")
    nxt = (_published_lessons(student).filter(course_id__in=started_courses).exclude(pk__in=done_lessons)
           .order_by("course_id", "order", "id").first())
    if nxt:
        add(5, "lesson", nxt.title, nxt.id, reason="الدرس التالي في دورتك", minutes=nxt.duration_minutes, sub=nxt.course.title)
    tried = set(Attempt.objects.filter(student=student).values_list("test_id", flat=True))
    for t in open_tests(student).exclude(pk__in=tried).order_by("closes_at", "id")[:2]:
        add(6, "quiz", t.title, t.id, t.closes_at, reason="اختبار مفتوح", minutes=t.duration_minutes)
    # Within overdue items reviews come first (rule 1); then oldest due first; ties by kind and id (deterministic).
    items.sort(key=lambda x: (x["priority"], 0 if x["priority"] == 1 and x["kind"] == AssignmentType.REVIEW else 1,
                              x["due"] or "9999", x["kind"], x["ref"]))
    todo = [i for i in items if i["state"] == "todo"]
    return {"date": today.isoformat(), "timezone": str(tz), "items": items,
            "counts": {"todo": len(todo), "done": len(items) - len(todo), "overdue": sum(1 for i in todo if i["priority"] == 1)},
            "est_minutes": sum(i["est_minutes"] or 0 for i in todo) or None, "rules": TODAY_RULES}


class TodayPlan(APIView):
    permission_classes = [IsStudent]

    def get(self, request):
        return Response(today_plan(request.user))
