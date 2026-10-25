"""
Spaced-repetition review engine (pack prompt 15). Transparent rules; the intervals are an admin setting
(AppSettings.review_intervals, default 1, 3, 7, 14, 30 days) and are product defaults, not guaranteed pedagogy.

1. When a teacher ACCEPTS a memorization (hifz) task, its range gets a review schedule: the first review is due
   intervals[0] days later (in the student's local calendar).
2. On the due date a review task is generated — once per cycle (database-enforced), never twice, and never while a
   previous review task for the same range is still open. A missed review stays open and overdue; nothing is deleted.
3. When the teacher reviews that task:
   - accepted with every score ≥ 4 and no repeat in this cycle → next interval (strong);
   - accepted with a lowest score of 3 → same interval again;
   - accepted after a needs-repeat in this cycle, or with any score ≤ 2 → one interval back (earlier review);
   - needs-repeat → the same task reopens for resubmission; the schedule waits for the final decision.
4. The teacher can override the next date (with a reason), pause or resume a schedule. Every change is recorded.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.core.models import AppSettings

from .models import Assignment, AssignmentStatus, AssignmentType, Feedback, ReviewEvent, ReviewSchedule

HELP_AR = (
    "عند اعتماد المعلم لحفظ مقطع، تُجدول له مراجعات متباعدة حسب الفواصل التي تحددها الإدارة (افتراضيًا بعد 1 ثم 3 ثم 7 ثم 14 ثم 30 يومًا). "
    "في موعد كل مراجعة تُنشأ مهمة مراجعة واحدة فقط. إذا اعتمد المعلم المراجعة وكل الدرجات 4 فأكثر تنتقل إلى الفاصل التالي، "
    "وإذا كانت أقل درجة 3 تتكرر المدة نفسها، وإذا طلب الإعادة أو كانت درجة 2 أو أقل تعود المراجعة إلى فاصل أقصر. "
    "المراجعة الفائتة تبقى ظاهرة ومتأخرة ولا تُحذف، ويستطيع المعلم تعديل الموعد مع ذكر السبب أو إيقاف الجدولة."
)


def _today(student) -> date:
    return timezone.now().astimezone(ZoneInfo(student.timezone or "Africa/Cairo")).date()


def _due_end(student, d: date) -> datetime:
    """A review is due by the end of that local day."""
    return datetime.combine(d, time(23, 59), ZoneInfo(student.timezone or "Africa/Cairo"))


def _interval(step: int) -> int:
    iv = AppSettings.load().intervals
    return iv[min(step, len(iv) - 1)]


def on_hifz_accepted(task: Assignment, actor) -> ReviewSchedule | None:
    if task.kind != AssignmentType.HIFZ or task.review_schedule_id:
        return None
    sch, created = ReviewSchedule.objects.get_or_create(
        source=task, defaults={"student": task.student, "teacher": task.teacher, "surah": task.surah, "ayah_from": task.ayah_from,
                               "ayah_to": task.ayah_to, "step": 0, "next_due": _today(task.student) + timedelta(days=_interval(0))})
    if created:
        ReviewEvent.objects.create(schedule=sch, kind=ReviewEvent.Kind.SCHEDULED, due_on=sch.next_due, step=0, actor=actor)
        Assignment.objects.filter(pk=task.pk).update(next_review_on=sch.next_due)
    return sch


def on_review_feedback(task: Assignment, fb: Feedback, actor) -> None:
    if not task.review_schedule_id:
        return
    sch = ReviewSchedule.objects.select_for_update().get(pk=task.review_schedule_id)
    if fb.decision == Feedback.Decision.REPEAT:
        ReviewEvent.objects.create(schedule=sch, kind=ReviewEvent.Kind.REPEAT, step=sch.step, outcome="repeat", assignment=task, actor=actor)
        return
    low = min(fb.score_hifz, fb.score_tajweed, fb.score_fluency)
    had_repeat = Feedback.objects.filter(submission__assignment=task, decision=Feedback.Decision.REPEAT).exists()
    if had_repeat or low <= 2:
        sch.step, outcome = max(sch.step - 1, 0), "earlier"
    elif low >= 4:
        sch.step, outcome = sch.step + 1, "next"
    else:
        sch.step, outcome = sch.step, "same"
    sch.next_due = _today(sch.student) + timedelta(days=_interval(sch.step))
    sch.save(update_fields=["step", "next_due", "updated_at"])
    ReviewEvent.objects.create(schedule=sch, kind=ReviewEvent.Kind.COMPLETED, due_on=sch.next_due, step=sch.step, outcome=outcome,
                               assignment=task, actor=actor)
    Assignment.objects.filter(pk=sch.source_id).update(next_review_on=sch.next_due)


def ensure_due(student) -> int:
    """Create the review tasks that are due today or earlier. Idempotent; safe to call on every request."""
    today = _today(student)
    made = 0
    for sid in ReviewSchedule.objects.filter(student=student, active=True, next_due__lte=today).values_list("pk", flat=True):
        try:
            with transaction.atomic():
                sch = ReviewSchedule.objects.select_for_update().get(pk=sid)
                if not sch.active or sch.next_due > today:
                    continue
                if sch.tasks.exclude(status=AssignmentStatus.ACCEPTED).exists():
                    continue  # the previous review is still open (missed or in progress): no second task
                sch.cycle += 1
                sch.save(update_fields=["cycle", "updated_at"])
                t = Assignment.objects.create(
                    student=sch.student, teacher=sch.teacher, kind=AssignmentType.REVIEW,
                    title=f"مراجعة: سورة {_surah_name(sch.surah)} {sch.ayah_from}–{sch.ayah_to}", surah=sch.surah,
                    ayah_from=sch.ayah_from, ayah_to=sch.ayah_to, due_at=_due_end(sch.student, sch.next_due),
                    instructions="مراجعة مجدولة لحفظ اعتمده معلمك.", review_schedule=sch, review_cycle=sch.cycle)
                ReviewEvent.objects.create(schedule=sch, kind=ReviewEvent.Kind.GENERATED, due_on=sch.next_due, step=sch.step, assignment=t)
                from apps.notifications.services import after_commit
                after_commit(sch.student, "review_due", "حان موعد مراجعة", t.title, link=f"/tasks/{t.pk}", dedupe=f"assignment:{t.pk}:review",
                             data={"assignment": t.pk})
                made += 1
        except IntegrityError:
            continue  # a concurrent request created this cycle's task first
    return made


def override(sch: ReviewSchedule, *, actor, next_due: date | None, reason: str, active: bool | None) -> ReviewSchedule:
    with transaction.atomic():
        sch = ReviewSchedule.objects.select_for_update().get(pk=sch.pk)
        if active is not None and active != sch.active:
            sch.active = active
            ReviewEvent.objects.create(schedule=sch, kind=ReviewEvent.Kind.RESUMED if active else ReviewEvent.Kind.PAUSED,
                                       step=sch.step, reason=reason, actor=actor)
        if next_due is not None and next_due != sch.next_due:
            sch.next_due = next_due
            ReviewEvent.objects.create(schedule=sch, kind=ReviewEvent.Kind.OVERRIDE, due_on=next_due, step=sch.step, reason=reason, actor=actor)
            # An open, not yet submitted review task moves with it.
            sch.tasks.filter(status__in=[AssignmentStatus.NOT_STARTED, AssignmentStatus.IN_PROGRESS]).update(due_at=_due_end(sch.student, next_due))
            Assignment.objects.filter(pk=sch.source_id).update(next_review_on=next_due)
        sch.save()
    return sch


def schedule_out(sch: ReviewSchedule, history: bool = False) -> dict:
    out = {"id": sch.id, "student": {"id": sch.student_id, "name": sch.student.full_name}, "surah": sch.surah,
           "surah_name": _surah_name(sch.surah), "ayah_from": sch.ayah_from, "ayah_to": sch.ayah_to, "step": sch.step,
           "interval_days": _interval(sch.step), "next_due": sch.next_due.isoformat(), "active": sch.active, "cycles": sch.cycle,
           "open_task": sch.tasks.exclude(status=AssignmentStatus.ACCEPTED).values_list("pk", flat=True).first()}
    if history:
        out["history"] = [{"at": e.created_at.isoformat(), "kind": e.kind, "kind_label": e.get_kind_display(), "due_on": e.due_on and e.due_on.isoformat(),
                           "step": e.step, "outcome": e.outcome, "reason": e.reason, "actor": e.actor.display_name if e.actor_id else None,
                           "assignment": e.assignment_id} for e in sch.events.select_related("actor")]
    return out


def _surah_name(n: int) -> str:
    from apps.quran.models import Surah

    name = Surah.objects.filter(source__is_active=True, number=n).values_list("name_ar", flat=True).first()
    return name or str(n)


# ---- API ------------------------------------------------------------------------------
from rest_framework.response import Response  # noqa: E402
from rest_framework.views import APIView  # noqa: E402

from apps.accounts.permissions import IsStudent, IsTeacher, assigned_student_ids  # noqa: E402
from apps.core.audit import audit  # noqa: E402
from apps.core.exceptions import ApiError  # noqa: E402

NOT_FOUND = ApiError("not_found", "العنصر المطلوب غير موجود.", 404)


class MyReviewSchedules(APIView):
    permission_classes = [IsStudent]

    def get(self, request):
        ensure_due(request.user)
        qs = ReviewSchedule.objects.filter(student=request.user).select_related("student").order_by("next_due")
        return Response({"help": HELP_AR, "results": [schedule_out(s) for s in qs]})


class TeacherReviewSchedules(APIView):
    """A teacher's view of one assigned student's schedules, with full history."""

    permission_classes = [IsTeacher]

    def get(self, request, pk):
        if not assigned_student_ids(request.user).filter(student_id=pk).exists():
            raise NOT_FOUND
        qs = ReviewSchedule.objects.filter(student_id=pk).select_related("student").order_by("next_due")
        return Response({"help": HELP_AR, "results": [schedule_out(s, history=True) for s in qs]})


class TeacherReviewOverride(APIView):
    permission_classes = [IsTeacher]

    def patch(self, request, pk):
        sch = ReviewSchedule.objects.select_related("student").filter(pk=pk).first()
        if sch is None or not assigned_student_ids(request.user).filter(student_id=sch.student_id).exists():
            raise NOT_FOUND
        reason = str(request.data.get("reason", "")).strip()[:200]
        if len(reason) < 3:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"reason": ["اذكر سبب التعديل."]})
        nd = request.data.get("next_due")
        try:
            next_due = date.fromisoformat(nd) if nd else None
        except ValueError:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"next_due": ["تاريخ غير صالح."]}) from None
        if next_due and not (_today(sch.student) <= next_due <= _today(sch.student) + timedelta(days=365)):
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"next_due": ["اختر تاريخًا من اليوم وحتى سنة."]})
        active = request.data.get("active")
        sch = override(sch, actor=request.user, next_due=next_due, reason=reason, active=None if active is None else bool(active))
        audit("review.override", actor=request.user, target=sch, request=request, next_due=nd, active=active, reason=reason)
        return Response(schedule_out(sch, history=True))
