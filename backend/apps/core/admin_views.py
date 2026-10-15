"""Administration API for the admin portal (separate sign-in, admin role only, every change audited).

Covers what the live console manages beyond accounts (apps.accounts.views): overview counts, teacher
approval, courses/lessons/enrollments, bookings, platform settings and the audit log.
"""
from __future__ import annotations

from datetime import timedelta
from urllib.parse import urlparse

from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import serializers
from rest_framework.generics import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import AccountStatus, Role, TeacherAssignment, TeacherProfile, User
from apps.accounts.permissions import IsAdminRole
from apps.learning.models import Course, Enrollment, Lesson, PublishState
from apps.scheduling.models import Booking
from apps.scheduling import services as scheduling

from .audit import audit
from .exceptions import ApiError
from .models import AppSettings, AuditEvent
from .pagination import StandardPagination

# Lesson videos are links to these providers only (no arbitrary embeds).
VIDEO_HOSTS = ("youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "vimeo.com", "player.vimeo.com")


def _page(view: APIView, request, qs, fn):
    p = StandardPagination()
    items = p.paginate_queryset(qs, request, view=view)
    return p.get_paginated_response([fn(x) for x in items])


def _reason(request, required=True) -> str:
    r = str(request.data.get("reason", "")).strip()[:200]
    if required and len(r) < 3:
        raise ApiError("invalid", "اكتب سبب الإجراء.", 400, {"reason": ["اكتب سبب الإجراء (3 أحرف على الأقل)."]})
    return r


class AdminView(APIView):
    permission_classes = [IsAdminRole]


# ---- Overview -------------------------------------------------------------------------
class AdminOverview(AdminView):
    def get(self, request):
        now = timezone.now()
        users = User.objects.exclude(role=Role.ADMIN)
        by = {(r["role"], r["status"]): r["n"] for r in users.values("role", "status").annotate(n=Count("id"))}
        n = lambda role, st: by.get((role, st), 0)  # noqa: E731
        unlinked = users.filter(role=Role.STUDENT, status=AccountStatus.ACTIVE).exclude(teacher_assignments__active=True).count()
        teachers_unapproved = users.filter(role=Role.TEACHER).filter(
            Q(teacher_profile__isnull=True) | Q(teacher_profile__approved_at__isnull=True)).count()
        upcoming = Booking.objects.filter(status=Booking.Status.CONFIRMED, occurrence__starts_at__gte=now)
        courses = {r["state"]: r["n"] for r in Course.objects.values("state").annotate(n=Count("id"))}
        today = Booking.objects.filter(status=Booking.Status.CONFIRMED, occurrence__starts_at__gte=now - timedelta(hours=1),
                                       occurrence__starts_at__lt=now + timedelta(hours=24)) \
            .select_related("occurrence__teacher", "student").order_by("occurrence__starts_at")[:8]
        return Response({
            "students": {"active": n(Role.STUDENT, "active"), "pending": n(Role.STUDENT, "pending"),
                         "suspended": n(Role.STUDENT, "suspended"), "unlinked": unlinked},
            "teachers": {"active": n(Role.TEACHER, "active"), "pending": n(Role.TEACHER, "pending"), "unapproved": teachers_unapproved},
            "parents": {"active": n(Role.PARENT, "active"), "pending": n(Role.PARENT, "pending")},
            "bookings": {"upcoming": upcoming.count(),
                         "cancelled_7d": Booking.objects.filter(status=Booking.Status.CANCELLED, cancelled_at__gte=now - timedelta(days=7)).count()},
            "courses": {s: courses.get(s, 0) for s in PublishState.values},
            "next_sessions": [_booking_out(b) for b in today],
        })


# ---- Teachers -------------------------------------------------------------------------
class AdminTeacherApprove(AdminView):
    """Approve a teacher so learners can find and book them. `{"approved": false}` withdraws approval."""

    def post(self, request, pk):
        t = get_object_or_404(User, pk=pk, role=Role.TEACHER)
        approve = request.data.get("approved", True) not in (False, "false", 0, "0")
        prof, _ = TeacherProfile.objects.get_or_create(user=t)
        prof.approved_at = timezone.now() if approve else None
        prof.save(update_fields=["approved_at"])
        if approve and t.status == AccountStatus.PENDING:
            t.status = AccountStatus.ACTIVE
            t.save(update_fields=["status"])
        audit("admin.teacher_approval", actor=request.user, target=t, request=request, approved=approve,
              reason=_reason(request, required=not approve))
        return Response({"id": t.id, "approved": approve, "status": t.status})


# ---- Courses, lessons, enrollments ----------------------------------------------------
class CourseIn(serializers.Serializer):
    title = serializers.CharField(min_length=2, max_length=160)
    description = serializers.CharField(allow_blank=True, required=False, max_length=4000)
    topic = serializers.ChoiceField(choices=["tajweed", "hifz", "adab", "ulum"], required=False, allow_blank=True)
    level = serializers.CharField(allow_blank=True, required=False, max_length=32)
    teacher = serializers.PrimaryKeyRelatedField(queryset=User.objects.filter(role=Role.TEACHER))
    restricted = serializers.BooleanField(required=False)


class LessonIn(serializers.Serializer):
    title = serializers.CharField(min_length=2, max_length=160)
    kind = serializers.ChoiceField(choices=[Lesson.Kind.TEXT, Lesson.Kind.VIDEO])  # stored files: not yet in the console
    body = serializers.CharField(allow_blank=True, required=False, max_length=20000)
    external_url = serializers.URLField(allow_blank=True, required=False)
    duration_minutes = serializers.IntegerField(min_value=1, max_value=600, required=False, allow_null=True)
    order = serializers.IntegerField(min_value=0, max_value=999, required=False)

    def validate_external_url(self, v):
        if v:
            u = urlparse(v)
            if u.scheme != "https" or (u.hostname or "").lower() not in VIDEO_HOSTS:
                raise serializers.ValidationError("الروابط المسموحة: YouTube أو Vimeo عبر https.")
        return v

    def validate(self, d):
        kind = d.get("kind", getattr(self.instance, "kind", None))
        if kind == Lesson.Kind.VIDEO and not d.get("external_url", getattr(self.instance, "external_url", "")):
            raise serializers.ValidationError({"external_url": ["أضف رابط الفيديو."]})
        if kind == Lesson.Kind.TEXT and not d.get("body", getattr(self.instance, "body", "")).strip():
            raise serializers.ValidationError({"body": ["اكتب نص الدرس."]})
        return d


def _course_out(c: Course) -> dict:
    return {"id": c.id, "title": c.title, "description": c.description, "topic": c.topic, "level": c.level,
            "teacher": {"id": c.teacher_id, "name": c.teacher.full_name}, "state": c.state, "restricted": c.restricted,
            "lessons": getattr(c, "n_lessons", None), "published_lessons": getattr(c, "n_published", None),
            "enrolled": getattr(c, "n_enrolled", None), "updated_at": c.updated_at.isoformat()}


def _lesson_out(l: Lesson) -> dict:
    return {"id": l.id, "course": l.course_id, "order": l.order, "title": l.title, "kind": l.kind, "body": l.body,
            "external_url": l.external_url, "duration_minutes": l.duration_minutes, "state": l.state,
            "has_file": l.media_id is not None, "updated_at": l.updated_at.isoformat()}


def _courses():
    return Course.objects.select_related("teacher").annotate(
        n_lessons=Count("lessons", distinct=True),
        n_published=Count("lessons", filter=Q(lessons__state=PublishState.PUBLISHED), distinct=True),
        n_enrolled=Count("enrollments", filter=Q(enrollments__status=Enrollment.Status.ACTIVE), distinct=True))


class AdminCourses(AdminView):
    def get(self, request):
        qs = _courses().order_by("-updated_at", "id")
        p = request.query_params
        if p.get("state"):
            qs = qs.filter(state=p["state"])
        if p.get("teacher"):
            qs = qs.filter(teacher_id=p["teacher"])
        if p.get("q"):
            qs = qs.filter(Q(title__icontains=p["q"]) | Q(description__icontains=p["q"]))
        return _page(self, request, qs, _course_out)

    def post(self, request):
        s = CourseIn(data=request.data)
        s.is_valid(raise_exception=True)
        c = Course.objects.create(**s.validated_data)  # always starts as a draft
        audit("admin.course_created", actor=request.user, target=c, request=request, title=c.title)
        return Response(_course_out(_courses().get(pk=c.pk)), status=201)


class AdminCourseDetail(AdminView):
    def get(self, request, pk):
        c = get_object_or_404(_courses(), pk=pk)
        lessons = [_lesson_out(l) for l in c.lessons.order_by("order", "id")]
        return Response({**_course_out(c), "lesson_list": lessons})

    def patch(self, request, pk):
        c = get_object_or_404(Course, pk=pk)
        s = CourseIn(data=request.data, partial=True)
        s.is_valid(raise_exception=True)
        for k, v in s.validated_data.items():
            setattr(c, k, v)
        c.save()
        audit("admin.course_updated", actor=request.user, target=c, request=request, fields=sorted(s.validated_data))
        return Response(_course_out(_courses().get(pk=c.pk)))


class AdminCourseState(AdminView):
    """draft → published → archived (and back to draft). Archiving keeps enrollments, completions and grades."""

    def post(self, request, pk):
        c = get_object_or_404(Course, pk=pk)
        new = request.data.get("state")
        if new not in (PublishState.DRAFT, PublishState.PUBLISHED, PublishState.ARCHIVED):
            raise ApiError("invalid", "حالة غير صالحة.", 400, {"state": ["اختر حالة صالحة."]})
        if new == PublishState.PUBLISHED and not c.lessons.filter(state=PublishState.PUBLISHED).exists():
            raise ApiError("no_published_lessons", "انشر درسًا واحدًا على الأقل قبل نشر الدورة.", 409)
        old = c.state
        c.state = new
        c.save(update_fields=["state", "updated_at"])
        audit("admin.course_state", actor=request.user, target=c, request=request, old=old, new=new,
              reason=_reason(request, required=new == PublishState.ARCHIVED))
        return Response(_course_out(_courses().get(pk=c.pk)))


class AdminLessons(AdminView):
    def post(self, request, pk):
        c = get_object_or_404(Course, pk=pk)
        s = LessonIn(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        if "order" not in d:
            d["order"] = (c.lessons.order_by("-order").values_list("order", flat=True).first() or 0) + 1
        l = Lesson.objects.create(course=c, **d)
        audit("admin.lesson_created", actor=request.user, target=l, request=request, course=c.id)
        return Response(_lesson_out(l), status=201)


class AdminLessonDetail(AdminView):
    def patch(self, request, pk):
        l = get_object_or_404(Lesson, pk=pk)
        s = LessonIn(l, data=request.data, partial=True)
        s.is_valid(raise_exception=True)
        for k, v in s.validated_data.items():
            setattr(l, k, v)
        l.save()
        audit("admin.lesson_updated", actor=request.user, target=l, request=request, fields=sorted(s.validated_data))
        return Response(_lesson_out(l))


class AdminLessonState(AdminView):
    def post(self, request, pk):
        l = get_object_or_404(Lesson.objects.select_related("course"), pk=pk)
        new = request.data.get("state")
        if new not in (PublishState.DRAFT, PublishState.PUBLISHED, PublishState.ARCHIVED):
            raise ApiError("invalid", "حالة غير صالحة.", 400, {"state": ["اختر حالة صالحة."]})
        with transaction.atomic():
            old = l.state
            l.state = new
            l.save(update_fields=["state", "updated_at"])
            # A published course must keep at least one published lesson.
            if l.course.state == PublishState.PUBLISHED and not l.course.lessons.filter(state=PublishState.PUBLISHED).exists():
                raise ApiError("last_published_lesson", "هذا آخر درس منشور في دورة منشورة. أعد الدورة إلى مسودة أولًا.", 409)
            audit("admin.lesson_state", actor=request.user, target=l, request=request, old=old, new=new)
        return Response(_lesson_out(l))


def _enrollment_out(e: Enrollment) -> dict:
    return {"id": e.id, "course": e.course_id, "student": {"id": e.student_id, "name": e.student.full_name, "email": e.student.email},
            "status": e.status, "starts_on": e.starts_on, "ends_on": e.ends_on, "created_at": e.created_at.isoformat()}


class AdminEnrollments(AdminView):
    def get(self, request, pk):
        qs = Enrollment.objects.filter(course_id=pk).select_related("student").order_by("-created_at", "id")
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return _page(self, request, qs, _enrollment_out)

    def post(self, request, pk):
        c = get_object_or_404(Course, pk=pk)
        if c.state == PublishState.ARCHIVED:
            raise ApiError("archived", "لا يمكن التسجيل في دورة مؤرشفة.", 409)
        student = get_object_or_404(User, pk=request.data.get("student"), role=Role.STUDENT)
        if student.status == AccountStatus.SUSPENDED:
            raise ApiError("suspended", "حساب الطالب موقوف.", 409)
        e = Enrollment.objects.filter(course=c, student=student, status=Enrollment.Status.ACTIVE).first()
        if e:
            raise ApiError("already_enrolled", "الطالب مسجّل في هذه الدورة بالفعل.", 409)
        e = Enrollment.objects.create(course=c, student=student, created_by=request.user, starts_on=timezone.localdate())
        audit("admin.enrolled", actor=request.user, target=e, request=request, course=c.id, student=student.id)
        return Response(_enrollment_out(e), status=201)


class AdminEnrollmentEnd(AdminView):
    def post(self, request, pk):
        e = get_object_or_404(Enrollment.objects.select_related("student"), pk=pk, status=Enrollment.Status.ACTIVE)
        new = request.data.get("status", Enrollment.Status.WITHDRAWN)
        if new not in (Enrollment.Status.WITHDRAWN, Enrollment.Status.COMPLETED):
            raise ApiError("invalid", "حالة غير صالحة.", 400)
        e.status, e.ends_on = new, timezone.localdate()
        e.save(update_fields=["status", "ends_on", "updated_at"])
        audit("admin.enrollment_ended", actor=request.user, target=e, request=request, status=new, reason=_reason(request, required=False))
        return Response(_enrollment_out(e))


# ---- Bookings -------------------------------------------------------------------------
def _booking_out(b: Booking) -> dict:
    o = b.occurrence
    return {"id": b.id, "status": b.status, "attendance": b.attendance, "starts_at": o.starts_at.isoformat(), "ends_at": o.ends_at.isoformat(),
            "kind": o.kind, "teacher": {"id": o.teacher_id, "name": o.teacher.full_name},
            "student": {"id": b.student_id, "name": b.student.full_name},
            "cancel_reason": b.cancel_reason, "cancelled_at": b.cancelled_at.isoformat() if b.cancelled_at else None}


class AdminBookings(AdminView):
    def get(self, request):
        p = request.query_params
        qs = Booking.objects.select_related("occurrence__teacher", "student")
        when = p.get("when", "upcoming")
        now = timezone.now()
        if when == "upcoming":
            qs = qs.filter(occurrence__starts_at__gte=now).order_by("occurrence__starts_at", "id")
        else:
            qs = qs.filter(occurrence__starts_at__lt=now).order_by("-occurrence__starts_at", "-id")
        if p.get("status"):
            qs = qs.filter(status=p["status"])
        if p.get("teacher"):
            qs = qs.filter(occurrence__teacher_id=p["teacher"])
        if p.get("q"):
            qs = qs.filter(Q(student__full_name__icontains=p["q"]) | Q(occurrence__teacher__full_name__icontains=p["q"]))
        return _page(self, request, qs, _booking_out)


class AdminBookingCancel(AdminView):
    def post(self, request, pk):
        reason = _reason(request)
        b = scheduling.cancel(booking_id=pk, by=request.user, reason=reason)
        audit("admin.booking_cancelled", actor=request.user, target=b, request=request, reason=reason)
        b = Booking.objects.select_related("occurrence__teacher", "student").get(pk=b.pk)
        return Response(_booking_out(b))


# ---- Settings and audit ---------------------------------------------------------------
class SettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = AppSettings
        fields = ["org_name", "support_email", "support_whatsapp", "show_support_button", "default_timezone", "cancel_hours",
                  "join_minutes", "individual_minutes", "group_minutes", "booking_horizon_days", "booking_lead_minutes",
                  "open_signup", "session_reminders", "parent_weekly_report", "max_recording_seconds", "max_upload_mb", "updated_at"]
        read_only_fields = ["updated_at"]
        extra_kwargs = {"cancel_hours": {"max_value": 168}, "booking_horizon_days": {"min_value": 1, "max_value": 90},
                        "booking_lead_minutes": {"max_value": 10080}, "max_recording_seconds": {"min_value": 30, "max_value": 3600},
                        "max_upload_mb": {"min_value": 1, "max_value": 100}, "individual_minutes": {"min_value": 10, "max_value": 240},
                        "group_minutes": {"min_value": 10, "max_value": 240}, "join_minutes": {"max_value": 60}}

    def validate_default_timezone(self, v):
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError):
            raise serializers.ValidationError("منطقة زمنية غير معروفة (مثال: Africa/Cairo).") from None
        return v


class AdminSettingsView(AdminView):
    def get(self, request):
        return Response(SettingsSerializer(AppSettings.load()).data)

    def patch(self, request):
        obj = AppSettings.load()
        s = SettingsSerializer(obj, data=request.data, partial=True)
        s.is_valid(raise_exception=True)
        changed = {k: [getattr(obj, k), v] for k, v in s.validated_data.items() if getattr(obj, k) != v}
        s.save(updated_by=request.user)
        if changed:
            audit("admin.settings_changed", actor=request.user, target=obj, request=request, changed=changed)
        return Response(s.data)


class AdminAudit(AdminView):
    def get(self, request):
        qs = AuditEvent.objects.select_related("actor").order_by("-created_at", "-id")
        p = request.query_params
        if p.get("action"):
            qs = qs.filter(action__startswith=p["action"])
        if p.get("target_type"):
            qs = qs.filter(target_type=p["target_type"], target_id=p.get("target_id", ""))
        return _page(self, request, qs, lambda e: {
            "id": e.id, "at": e.created_at.isoformat(), "action": e.action, "actor": e.actor.full_name if e.actor else None,
            "target": f"{e.target_type}:{e.target_id}", "data": e.data})


__all__ = ["AdminOverview", "AdminTeacherApprove", "AdminCourses", "AdminCourseDetail", "AdminCourseState", "AdminLessons",
           "AdminLessonDetail", "AdminLessonState", "AdminEnrollments", "AdminEnrollmentEnd", "AdminBookings",
           "AdminBookingCancel", "AdminSettingsView", "AdminAudit", "TeacherAssignment"]
