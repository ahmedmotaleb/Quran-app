"""Admin portal: courses, lessons and enrollments (pack prompt 07).

Reuses Course / Lesson / Enrollment. Archiving keeps enrollments, completions and grades; unpublished lessons and
restricted courses stay unreachable for learners (see learning.views._published_lessons). Every change is audited.
"""
from __future__ import annotations

from urllib.parse import urlparse

from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import serializers
from rest_framework.generics import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import AccountStatus, Role, User
from apps.accounts.permissions import IsAdminRole
from apps.core.audit import audit
from apps.core.exceptions import ApiError
from apps.core.pagination import StandardPagination

from .models import Course, Enrollment, Lesson, PublishState

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


def notify_enrolled(course, kind: str, title: str, body: str, *, dedupe: str, data: dict) -> None:
    """Only learners actively enrolled in the course hear about its new content (relevant, not broadcast)."""
    from apps.notifications.services import after_commit

    for e in Enrollment.objects.filter(course=course, status=Enrollment.Status.ACTIVE).select_related("student"):
        after_commit(e.student, kind, title, f"{body} · {course.title}", dedupe=dedupe, data=data)


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
    kind = serializers.ChoiceField(choices=Lesson.Kind.choices)
    media = serializers.UUIDField(required=False, allow_null=True)  # an uploaded lesson file (audio or PDF kinds)
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
        if kind in (Lesson.Kind.AUDIO, Lesson.Kind.PDF):
            if "media" in d:
                d["media"] = self._lesson_file(d["media"], kind)
            elif not getattr(self.instance, "media_id", None):
                raise serializers.ValidationError({"media": ["ارفع ملف الدرس."]})
        elif "media" in d or (self.instance is not None and "kind" in d):
            d["media"] = None  # text and video lessons carry no stored file
        return d

    def _lesson_file(self, mid, kind):
        """The file must be a validated lesson upload of the right type, by this author (admins: any), unused."""
        from apps.media.models import MediaObject

        if mid is None:
            raise serializers.ValidationError({"media": ["ارفع ملف الدرس."]})
        user = self.context["request"].user
        m = MediaObject.objects.filter(pk=mid, purpose=MediaObject.Purpose.LESSON_FILE, state=MediaObject.State.VALIDATED).first()
        from apps.accounts.admin_access import acts_as_admin, has

        if m is None or (not (acts_as_admin(user) and has(user, "lessons.manage")) and m.owner_id != user.pk):
            raise serializers.ValidationError({"media": ["الملف غير صالح. ارفعه مرة أخرى."]})
        is_pdf = m.content_type == "application/pdf"
        if (kind == Lesson.Kind.PDF) != is_pdf:
            raise serializers.ValidationError({"media": ["نوع الملف لا يطابق نوع الدرس (PDF أو صوت)."]})
        if Lesson.objects.filter(media=m).exclude(pk=getattr(self.instance, "pk", None)).exists():
            raise serializers.ValidationError({"media": ["هذا الملف مرفق بدرس آخر."]})
        return m


def _course_out(c: Course) -> dict:
    return {"id": c.id, "title": c.title, "description": c.description, "topic": c.topic, "level": c.level,
            "teacher": {"id": c.teacher_id, "name": c.teacher.full_name}, "state": c.state, "restricted": c.restricted,
            "lessons": getattr(c, "n_lessons", None), "published_lessons": getattr(c, "n_published", None),
            "enrolled": getattr(c, "n_enrolled", None), "updated_at": c.updated_at.isoformat()}


def _lesson_out(l: Lesson) -> dict:
    return {"id": l.id, "course": l.course_id, "order": l.order, "title": l.title, "kind": l.kind, "body": l.body,
            "external_url": l.external_url, "duration_minutes": l.duration_minutes, "state": l.state,
            "has_file": l.media_id is not None, "file_type": l.media.content_type if l.media_id else None,
            "updated_at": l.updated_at.isoformat()}


def _courses():
    return Course.objects.select_related("teacher").annotate(
        n_lessons=Count("lessons", distinct=True),
        n_published=Count("lessons", filter=Q(lessons__state=PublishState.PUBLISHED), distinct=True),
        n_enrolled=Count("enrollments", filter=Q(enrollments__status=Enrollment.Status.ACTIVE), distinct=True))


class AdminCourses(AdminView):
    admin_perm = {"read": "courses.view", "write": "courses.manage"}
    def get(self, request):
        from apps.core.bulk import list_with

        from .admin_bulk import COURSE_FILTERS

        return list_with(self, request, _courses(), COURSE_FILTERS, _course_out)

    def post(self, request):
        s = CourseIn(data=request.data)
        s.is_valid(raise_exception=True)
        c = Course.objects.create(**s.validated_data)  # always starts as a draft
        audit("admin.course_created", actor=request.user, target=c, request=request, title=c.title)
        return Response(_course_out(_courses().get(pk=c.pk)), status=201)


class AdminCourseDetail(AdminView):
    admin_perm = {"read": "courses.view", "write": "courses.manage"}
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
    admin_perm = "courses.manage"

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
    admin_perm = {"read": "courses.view", "write": "lessons.manage"}
    def post(self, request, pk):
        c = get_object_or_404(Course, pk=pk)
        s = LessonIn(data=request.data, context={"request": request})
        s.is_valid(raise_exception=True)
        d = s.validated_data
        if "order" not in d:
            d["order"] = (c.lessons.order_by("-order").values_list("order", flat=True).first() or 0) + 1
        l = Lesson.objects.create(course=c, **d)
        audit("admin.lesson_created", actor=request.user, target=l, request=request, course=c.id)
        return Response(_lesson_out(l), status=201)


class AdminLessonDetail(AdminView):
    admin_perm = {"read": "courses.view", "write": "lessons.manage"}
    def patch(self, request, pk):
        l = get_object_or_404(Lesson, pk=pk)
        s = LessonIn(l, data=request.data, partial=True, context={"request": request})
        s.is_valid(raise_exception=True)
        for k, v in s.validated_data.items():
            setattr(l, k, v)
        l.save()
        audit("admin.lesson_updated", actor=request.user, target=l, request=request, fields=sorted(s.validated_data))
        return Response(_lesson_out(l))


class AdminLessonState(AdminView):
    admin_perm = "lessons.manage"
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
            if new == PublishState.PUBLISHED and old != new and l.course.state == PublishState.PUBLISHED:
                notify_enrolled(l.course, "lesson_published", "درس جديد في دورتك", l.title, dedupe=f"lesson:{l.pk}:published",
                                data={"lesson": l.pk})
        return Response(_lesson_out(l))


def _enrollment_out(e: Enrollment) -> dict:
    return {"id": e.id, "course": e.course_id, "student": {"id": e.student_id, "name": e.student.full_name, "email": e.student.email},
            "status": e.status, "starts_on": e.starts_on, "ends_on": e.ends_on, "created_at": e.created_at.isoformat()}


class AdminEnrollments(AdminView):
    admin_perm = {"read": "courses.view", "write": "courses.manage"}
    def get(self, request, pk):
        from .admin_bulk import ENROLLMENT_FILTERS

        p = request.query_params
        qs = ENROLLMENT_FILTERS.run(Enrollment.objects.filter(course_id=pk).select_related("student"), p, sort=p.get("sort"))
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
    admin_perm = "courses.manage"
    def post(self, request, pk):
        e = get_object_or_404(Enrollment.objects.select_related("student"), pk=pk, status=Enrollment.Status.ACTIVE)
        new = request.data.get("status", Enrollment.Status.WITHDRAWN)
        if new not in (Enrollment.Status.WITHDRAWN, Enrollment.Status.COMPLETED):
            raise ApiError("invalid", "حالة غير صالحة.", 400)
        e.status, e.ends_on = new, timezone.localdate()
        e.save(update_fields=["status", "ends_on", "updated_at"])
        audit("admin.enrollment_ended", actor=request.user, target=e, request=request, status=new, reason=_reason(request, required=False))
        return Response(_enrollment_out(e))
