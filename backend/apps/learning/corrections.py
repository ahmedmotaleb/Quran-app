"""Student mistakes / correction history (pack prompt 33).

Who sees what:
- student: own corrections (no internal teacher note);
- teacher: corrections of students actively assigned to them (with internal notes); only they and admins edit;
- parent: linked children only, parent-safe fields (category, reference, priority, status, dates; no free text);
- admin: everything, plus an aggregate without student content.

Recurrence = earlier corrections of the same student, category, surah and ayah. Raw counts are never turned into a
score: a student who practises more naturally collects more corrections.
"""
from __future__ import annotations

from datetime import timedelta

from django.db import transaction
from django.db.models import Count, IntegerField, OuterRef, Q, Subquery
from django.db.models.functions import Coalesce, TruncWeek
from django.utils import timezone
from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import Role, User
from apps.accounts.permissions import IsAdminRole, IsLearningUser, IsTeacher, assigned_student_ids, scope_by_student
from apps.core.audit import audit
from apps.core.exceptions import ApiError
from apps.core.pagination import StandardPagination
from apps.quran.models import HAFS_AYAH_COUNTS

from .models import Assignment, AssignmentType, Correction, Submission

NOT_FOUND = ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
C = Correction


def _with_recurrence(qs):
    """`times` = how many corrections this student has for the same category at the same ayah (this one included)."""
    same = (C.objects.filter(student=OuterRef("student"), category=OuterRef("category"), surah=OuterRef("surah"), ayah=OuterRef("ayah"))
            .order_by().values("student").annotate(n=Count("id")).values("n"))
    return qs.annotate(times=Coalesce(Subquery(same, output_field=IntegerField()), 1))


def out(c: Correction, user) -> dict:
    d = {"id": c.id, "student": c.student_id, "category": c.category, "category_label": C.Category(c.category).label,
         "surah": c.surah, "ayah": c.ayah, "priority": c.priority, "status": c.status, "source": c.source,
         "times": getattr(c, "times", 1), "created_at": c.created_at.isoformat(),
         "resolved_at": c.resolved_at.isoformat() if c.resolved_at else None}
    if user.role == Role.PARENT:
        return d  # parent-safe: no free text, no teacher identity, no links to recordings
    d.update({"note": c.note, "guidance": c.guidance, "teacher": c.teacher_id, "teacher_name": c.teacher.full_name,
              "submission": c.submission_id, "booking": c.booking_id, "assignment": c.assignment_id,
              "follow_up": c.follow_up_id, "student_name": c.student.full_name})
    if user.role in (Role.TEACHER, Role.ADMIN):
        d["internal_note"] = c.internal_note
    return d


class CorrectionIn(serializers.Serializer):
    student = serializers.PrimaryKeyRelatedField(queryset=User.objects.filter(role=Role.STUDENT))
    source = serializers.ChoiceField(choices=C.Source.choices)
    submission = serializers.IntegerField(required=False, allow_null=True)
    booking = serializers.IntegerField(required=False, allow_null=True)
    assignment = serializers.IntegerField(required=False, allow_null=True)
    surah = serializers.IntegerField(min_value=1, max_value=114)
    ayah = serializers.IntegerField(min_value=1)
    category = serializers.ChoiceField(choices=C.Category.choices)
    priority = serializers.ChoiceField(choices=C.Priority.choices, default=C.Priority.REVIEW)
    note = serializers.CharField(max_length=500, required=False, allow_blank=True, default="")
    guidance = serializers.CharField(max_length=500, required=False, allow_blank=True, default="")
    internal_note = serializers.CharField(max_length=500, required=False, allow_blank=True, default="")

    def validate(self, d):
        n = HAFS_AYAH_COUNTS[d["surah"] - 1]
        if d["ayah"] > n:
            raise serializers.ValidationError({"ayah": [f"السورة تحتوي {n} آية فقط."]})
        return d


class CorrectionPatch(serializers.Serializer):
    status = serializers.ChoiceField(choices=C.Status.choices, required=False)
    priority = serializers.ChoiceField(choices=C.Priority.choices, required=False)
    category = serializers.ChoiceField(choices=C.Category.choices, required=False)
    note = serializers.CharField(max_length=500, required=False, allow_blank=True)
    guidance = serializers.CharField(max_length=500, required=False, allow_blank=True)
    internal_note = serializers.CharField(max_length=500, required=False, allow_blank=True)


def _can_teach(user, student_id: int) -> bool:
    if user.role == Role.ADMIN:
        from apps.accounts.admin_access import has

        return has(user, "feedback.view")
    return user.role == Role.TEACHER and assigned_student_ids(user).filter(student_id=student_id).exists()


def _visible(user):
    return scope_by_student(C.objects.select_related("teacher", "student"), user)


class CorrectionList(APIView):
    """GET (all learning roles, scoped): ?student, status (comma list), category, surah, submission, booking, open=1,
    recurring=1. POST (teacher of the student): record a correction."""

    permission_classes = [IsLearningUser]

    def get(self, request):
        qs = _with_recurrence(_visible(request.user))
        p = request.query_params
        try:
            for k in ("student", "surah", "submission", "booking"):
                if p.get(k):
                    qs = qs.filter(**{f"{k}_id" if k in ("student", "submission", "booking") else k: int(p[k])})
        except ValueError:
            raise ApiError("invalid", "تحقق من عوامل التصفية.", 400) from None
        if p.get("status"):
            qs = qs.filter(status__in=[s for s in p["status"].split(",") if s in C.Status.values])
        if p.get("category") in C.Category.values:
            qs = qs.filter(category=p["category"])
        if p.get("open") == "1":
            qs = qs.exclude(status=C.Status.CORRECTED)
        if p.get("recurring") == "1":
            qs = qs.filter(times__gt=1)
        pg = StandardPagination()
        page = pg.paginate_queryset(qs.order_by("-created_at", "-id"), request, view=self)
        return pg.get_paginated_response([out(c, request.user) for c in page])

    def post(self, request):
        u = request.user
        if u.role != Role.TEACHER:
            raise ApiError("permission_denied", "ليست لديك صلاحية لهذا الإجراء.", 403)
        s = CorrectionIn(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        student = d.pop("student")
        if not _can_teach(u, student.pk):
            raise ApiError("not_your_student", "هذا الطالب غير مرتبط بك.", 403)
        links = {}
        if d.get("submission"):
            sub = Submission.objects.select_related("assignment").filter(pk=d["submission"], student=student).first()
            if sub is None:
                raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"submission": ["التسليم لا يخص هذا الطالب."]})
            links["submission"] = sub
            links["assignment"] = sub.assignment
        if d.get("booking"):
            from apps.scheduling.models import Booking

            b = Booking.objects.filter(pk=d["booking"], student=student, occurrence__teacher=u).first()
            if b is None:
                raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"booking": ["الجلسة ليست مع هذا الطالب لديك."]})
            links["booking"] = b
        if d.get("assignment") and "assignment" not in links:
            a = Assignment.objects.filter(pk=d["assignment"], student=student).first()
            if a is None:
                raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"assignment": ["المهمة لا تخص هذا الطالب."]})
            links["assignment"] = a
        need = {C.Source.SUBMISSION: "submission", C.Source.SESSION: "booking"}.get(d["source"])
        if need and need not in links:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {need: ["مطلوب لهذا المصدر."]})
        for k in ("submission", "booking", "assignment"):
            d.pop(k, None)
        with transaction.atomic():
            c = C.objects.create(student=student, teacher=u, **links, **d)
            audit("correction.created", actor=u, target=c, request=request, student=student.pk, category=c.category, source=c.source)
            from apps.notifications.services import after_commit

            after_commit(student, "correction_new", "أضاف معلمك ملاحظة جديدة للمراجعة", C.Category(c.category).label,
                         link="/mistakes", dedupe=f"correction:{c.pk}:new", data={"correction": c.pk})
        return Response(out(_with_recurrence(C.objects.select_related("teacher", "student")).get(pk=c.pk), u), status=201)


class CorrectionDetail(APIView):
    permission_classes = [IsLearningUser]

    def _get(self, request, pk):
        c = _with_recurrence(_visible(request.user)).filter(pk=pk).first()
        if c is None:
            raise NOT_FOUND
        return c

    def get(self, request, pk):
        return Response(out(self._get(request, pk), request.user))

    def patch(self, request, pk):
        c = self._get(request, pk)
        if not _can_teach(request.user, c.student_id):
            raise ApiError("permission_denied", "ليست لديك صلاحية لهذا الإجراء.", 403)
        s = CorrectionPatch(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        old = c.status
        with transaction.atomic():
            for k, v in d.items():
                setattr(c, k, v)
            if "status" in d:
                c.resolved_at = timezone.now() if d["status"] == C.Status.CORRECTED else None
            c.save()
            action = ("correction.resolved" if d.get("status") == C.Status.CORRECTED and old != C.Status.CORRECTED
                      else "correction.reopened" if old == C.Status.CORRECTED and d.get("status") not in (None, C.Status.CORRECTED)
                      else "correction.updated")
            audit(action, actor=request.user, target=c, request=request, fields=sorted(d), old_status=old, new_status=c.status)
        return Response(out(self._get(request, pk), request.user))


class CorrectionFollowUp(APIView):
    """Create an explicit practice task from an unresolved correction (the review scheduler is not changed)."""

    permission_classes = [IsTeacher]

    KINDS = {"ayah": (AssignmentType.REVIEW, "مراجعة الآية"), "tajweed": (AssignmentType.TAJWEED, "مراجعة حكم تجويد"),
             "rerecord": (AssignmentType.REVIEW, "إعادة تسجيل الجزء")}

    def post(self, request, pk):
        c = _visible(request.user).filter(pk=pk).first()
        if c is None or not _can_teach(request.user, c.student_id):
            raise NOT_FOUND
        if c.status == C.Status.CORRECTED:
            raise ApiError("already_corrected", "تم تصحيح هذه النقطة بالفعل.", 409)
        if c.follow_up_id:
            raise ApiError("already_has_task", "أُنشئت مهمة لهذه النقطة من قبل.", 409)
        kind_key = str(request.data.get("kind", "ayah"))
        if kind_key not in self.KINDS:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"kind": ["اختر نوع المهمة."]})
        kind, label = self.KINDS[kind_key]
        try:
            days = max(1, min(14, int(request.data.get("days", 2))))
        except (TypeError, ValueError):
            days = 2
        with transaction.atomic():
            a = Assignment.objects.create(
                student=c.student, teacher=request.user, kind=kind, title=f"{label}: {C.Category(c.category).label}",
                surah=c.surah, ayah_from=c.ayah, ayah_to=c.ayah, instructions=c.guidance or c.note,
                due_at=timezone.now() + timedelta(days=days), requires_recording=True)
            c.follow_up = a
            if c.status == C.Status.NEW:
                c.status = C.Status.IMPROVING
            c.save(update_fields=["follow_up", "status", "updated_at"])
            audit("correction.follow_up_created", actor=request.user, target=c, request=request, assignment=a.pk, kind=kind_key)
            from apps.notifications.services import after_commit

            after_commit(c.student, "assignment_new", "واجب جديد من معلمك", f"{a.title} · {request.user.full_name}",
                         link=f"/tasks/{a.pk}", dedupe=f"assignment:{a.pk}:new", data={"assignment": a.pk})
        return Response({"correction": out(_with_recurrence(_visible(request.user)).get(pk=c.pk), request.user), "assignment": a.pk},
                        status=201)


def summary_for(qs) -> dict:
    """Learning-point metrics (never a score): open / improving / corrected, recurring, by category, 8-week trend."""
    qs = _with_recurrence(qs)
    by_status = {s: 0 for s in C.Status.values}
    for r in qs.values("status").annotate(n=Count("id")):
        by_status[r["status"]] = r["n"]
    open_qs = qs.exclude(status=C.Status.CORRECTED)
    cats = [{"category": r["category"], "label": C.Category(r["category"]).label, "open": r["open"], "total": r["total"]}
            for r in qs.values("category").annotate(total=Count("id"), open=Count("id", filter=~Q(status=C.Status.CORRECTED)))
            .order_by("-open", "-total")]
    since = timezone.now() - timedelta(weeks=8)
    added = {r["w"].date().isoformat(): r["n"] for r in qs.filter(created_at__gte=since).annotate(w=TruncWeek("created_at"))
             .values("w").annotate(n=Count("id")) if r["w"]}
    fixed = {r["w"].date().isoformat(): r["n"] for r in qs.filter(resolved_at__gte=since).annotate(w=TruncWeek("resolved_at"))
             .values("w").annotate(n=Count("id")) if r["w"]}
    weeks = sorted(set(added) | set(fixed))
    return {"open": by_status[C.Status.NEW] + by_status[C.Status.IMPROVING], "new": by_status[C.Status.NEW],
            "improving": by_status[C.Status.IMPROVING], "corrected": by_status[C.Status.CORRECTED],
            "recurring": open_qs.filter(times__gt=1).count(), "by_category": cats,
            "trend": [{"week": w, "added": added.get(w, 0), "corrected": fixed.get(w, 0)} for w in weeks]}


class CorrectionSummary(APIView):
    """?student= (required for teachers and parents; students get their own)."""

    permission_classes = [IsLearningUser]

    def get(self, request):
        qs = _visible(request.user)
        sid = request.query_params.get("student")
        if request.user.role == Role.STUDENT:
            sid = request.user.pk
        if not sid:
            raise ApiError("invalid", "حدّد الطالب.", 400, {"student": ["مطلوب."]})
        try:
            qs = qs.filter(student_id=int(sid))
        except ValueError:
            raise ApiError("invalid", "حدّد الطالب.", 400) from None
        if not _is_visible_student(request.user, int(sid)):
            raise NOT_FOUND
        return Response({"student": int(sid), **summary_for(qs)})


def _is_visible_student(user, sid: int) -> bool:
    from apps.accounts.permissions import can_view_student

    student = User.objects.filter(pk=sid, role=Role.STUDENT).first()
    return student is not None and can_view_student(user, student)


class TeacherCorrectionOverview(APIView):
    """Teacher dashboard: students with unresolved points, repeated memorization / Tajweed points, points to re-check."""

    permission_classes = [IsTeacher]

    def get(self, request):
        qs = _with_recurrence(C.objects.filter(student_id__in=assigned_student_ids(request.user)).select_related("student"))
        open_qs = qs.exclude(status=C.Status.CORRECTED)
        per_student = [{"student": r["student"], "name": r["student__full_name"], "open": r["n"]}
                       for r in open_qs.values("student", "student__full_name").annotate(n=Count("id")).order_by("-n")[:20]]
        rep = open_qs.filter(times__gt=1)
        item = lambda c: {"id": c.id, "student": c.student_id, "name": c.student.full_name, "category": c.category,  # noqa: E731
                          "label": C.Category(c.category).label, "surah": c.surah, "ayah": c.ayah, "times": c.times}
        return Response({
            "students_with_open": per_student,
            "repeated_memorization": [item(c) for c in rep.filter(category__in=C.MEMORIZATION)[:20]],
            "repeated_tajweed": [item(c) for c in rep.exclude(category__in=C.MEMORIZATION)[:20]],
            "awaiting_recheck": [item(c) for c in open_qs.filter(status=C.Status.IMPROVING)[:20]],
        })


class AdminCorrectionSummary(APIView):
    """Aggregate only: counts by category and status across the platform, no student content."""
    admin_perm = "analytics.view"

    permission_classes = [IsAdminRole]

    def get(self, request):
        qs = C.objects.all()
        rows = qs.values("category").annotate(total=Count("id"), open=Count("id", filter=~Q(status=C.Status.CORRECTED)))
        return Response({"total": qs.count(), "open": qs.exclude(status=C.Status.CORRECTED).count(),
                         "students_with_open": qs.exclude(status=C.Status.CORRECTED).values("student").distinct().count(),
                         "by_category": [{"category": r["category"], "label": C.Category(r["category"]).label, "total": r["total"],
                                          "open": r["open"]} for r in rows.order_by("-total")]})


def categories() -> list[dict]:
    return [{"value": v, "label": label, "memorization": v in C.MEMORIZATION} for v, label in C.Category.choices]


class CorrectionCategories(APIView):
    permission_classes = [IsLearningUser]

    def get(self, request):
        return Response(categories())
