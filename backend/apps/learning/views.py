from rest_framework import generics
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import User, Role
from apps.accounts.permissions import IsLearningUser, IsStudent, IsTeacher, assigned_student_ids, scope_by_student
from apps.core.audit import audit
from apps.core.exceptions import ApiError

from . import services
from .models import Assignment, AssignmentStatus
from .serializers import AssignmentSerializer


class AssignmentList(generics.ListCreateAPIView):
    """Students: own work. Teachers: work they assigned / for assigned students. Parents: linked children."""

    permission_classes = [IsLearningUser]
    serializer_class = AssignmentSerializer

    def list(self, request, *args, **kwargs):
        # Due spaced-repetition reviews become tasks when someone who can see them looks (idempotent).
        from apps.accounts.permissions import visible_student_ids

        from . import reviews
        ids = visible_student_ids(request.user)
        for st in (User.objects.filter(pk__in=ids) if ids is not None else []):
            reviews.ensure_due(st)
        return super().list(request, *args, **kwargs)

    def get_queryset(self):
        qs = scope_by_student(Assignment.objects.select_related("teacher", "student"), self.request.user)
        p = self.request.query_params
        if p.get("kind"):
            qs = qs.filter(kind=p["kind"])
        if p.get("status"):
            qs = qs.filter(status__in=p["status"].split(","))
        if p.get("student"):
            qs = qs.filter(student_id=p["student"])
        return qs.order_by("due_at", "id")

    def perform_create(self, serializer):
        u = self.request.user
        if u.role != Role.TEACHER:
            raise ApiError("permission_denied", "ليست لديك صلاحية لهذا الإجراء.", 403)
        student = serializer.validated_data["student"]
        if not assigned_student_ids(u).filter(student_id=student.pk).exists():
            raise ApiError("not_your_student", "هذا الطالب غير مرتبط بك.", 403)
        a = serializer.save(teacher=u)
        audit("assignment.created", actor=u, target=a, request=self.request)
        from apps.notifications.services import after_commit
        after_commit(a.student, "assignment_new", "واجب جديد من معلمك", f"{a.title} · {u.full_name}", link=f"/tasks/{a.pk}",
                     dedupe=f"assignment:{a.pk}:new", data={"assignment": a.pk})


class AssignmentDetail(generics.RetrieveAPIView):
    permission_classes = [IsLearningUser]
    serializer_class = AssignmentSerializer

    def get_queryset(self):
        return scope_by_student(Assignment.objects.select_related("teacher", "student"), self.request.user)


class AssignmentStart(APIView):
    """Student marks the task as started (e.g. when opening the recorder)."""

    permission_classes = [IsStudent]

    def post(self, request, pk):
        a = Assignment.objects.filter(pk=pk, student=request.user).first()
        if a is None:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        if a.status in (AssignmentStatus.NOT_STARTED, AssignmentStatus.NEEDS_REPEAT):
            a = services.transition(a, AssignmentStatus.IN_PROGRESS, actor=request.user)
        return Response(AssignmentSerializer(a).data)


# ---- Submissions & teacher feedback (Prompt 14) ----------------------------------------
from django.db import IntegrityError, transaction  # noqa: E402
from django.db.models import Prefetch, Q  # noqa: E402

from apps.core.pagination import StandardPagination  # noqa: E402
from apps.media.models import MediaObject  # noqa: E402
from apps.notifications.services import notify  # noqa: E402

from .models import Feedback, FeedbackNote, Submission  # noqa: E402
from .serializers import FeedbackInSerializer  # noqa: E402

NOT_FOUND = ApiError("not_found", "العنصر المطلوب غير موجود.", 404)


def _submissions(user):
    qs = Submission.objects.select_related("assignment", "student", "media", "feedback__teacher", "feedback__voice").prefetch_related(
        Prefetch("feedback__notes", queryset=FeedbackNote.objects.order_by("at_seconds")))
    return scope_by_student(qs, user)


class SubmissionList(APIView):
    """Scoped list. Teachers: `?state=pending|reviewed`. Everyone: `?assignment=`."""

    permission_classes = [IsLearningUser]

    def get(self, request):
        qs = _submissions(request.user)
        p = request.query_params
        if p.get("assignment"):
            qs = qs.filter(assignment_id=p["assignment"])
        if p.get("state") == "pending":
            qs = qs.filter(feedback__isnull=True)
        elif p.get("state") == "reviewed":
            qs = qs.filter(feedback__isnull=False)
        pg = StandardPagination()
        page = pg.paginate_queryset(qs.order_by("-created_at"), request, view=self)
        return pg.get_paginated_response([services.submission_out(s, request.user, request) for s in page])


class SubmissionDetail(APIView):
    permission_classes = [IsLearningUser]

    def get(self, request, pk):
        s = _submissions(request.user).filter(pk=pk).first()
        if s is None:
            raise NOT_FOUND
        return Response(services.submission_out(s, request.user, request))


class SubmissionCreate(APIView):
    """Student submits an uploaded recitation for an assignment. Requires an Idempotency-Key."""

    permission_classes = [IsStudent]

    def post(self, request, pk):
        key = request.headers.get("Idempotency-Key", "").strip()
        if not key or len(key) > 64:
            raise ApiError("idempotency_key_required", "أعد المحاولة من التطبيق.", 400)
        existing = Submission.objects.filter(student=request.user, idempotency_key=key).first()
        if existing is not None:
            return Response(services.submission_out(existing, request.user, request), status=200)
        try:
            media_id = str(request.data.get("media", ""))
            m = MediaObject.objects.filter(pk=media_id, owner=request.user, purpose=MediaObject.Purpose.RECITATION,
                                           state=MediaObject.State.VALIDATED).first()
        except Exception:  # noqa: BLE001 — malformed UUID
            m = None
        if m is None:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"media": ["ارفع التسجيل أولًا."]})
        try:
            with transaction.atomic():
                a = Assignment.objects.select_for_update().filter(pk=pk, student=request.user).first()
                if a is None:
                    raise NOT_FOUND
                if a.status not in (AssignmentStatus.NOT_STARTED, AssignmentStatus.IN_PROGRESS, AssignmentStatus.NEEDS_REPEAT):
                    raise ApiError("not_submittable", "لا يمكن تسليم هذه المهمة الآن.", 409)
                if Submission.objects.filter(media=m).exists():
                    raise ApiError("media_in_use", "هذا التسجيل مُسلَّم بالفعل.", 409)
                attempt = Submission.objects.filter(assignment=a).count() + 1
                s = Submission.objects.create(assignment=a, student=request.user, media=m, attempt=attempt,
                                              duration_seconds=m.duration_seconds or 0, idempotency_key=key)
                services.transition(a, AssignmentStatus.SUBMITTED, actor=request.user)
                teacher, title, sid = a.teacher, a.title, s.pk
                transaction.on_commit(lambda: notify(teacher, "submission_new", "تسليم جديد", f"{request.user.full_name} · {title}",
                                                     link=f"/teacher/reviews/{sid}", dedupe=f"submission:{sid}",
                                                     data={"submission": sid}))
        except IntegrityError:
            # Same key raced in from a retry: return the stored result.
            existing = Submission.objects.filter(student=request.user, idempotency_key=key).first()
            if existing is None:
                raise
            return Response(services.submission_out(existing, request.user, request), status=200)
        audit("submission.created", actor=request.user, target=s, request=request, attempt=attempt)
        return Response(services.submission_out(_submissions(request.user).get(pk=s.pk), request.user, request), status=201)


class FeedbackCreate(APIView):
    """The student's assigned teacher reviews the latest attempt. One feedback per submission."""

    permission_classes = [IsTeacher]

    def post(self, request, pk):
        ser = FeedbackInSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        d = ser.validated_data
        voice = None
        if d["voice"]:
            voice = MediaObject.objects.filter(pk=d["voice"], owner=request.user, purpose=MediaObject.Purpose.VOICE_FEEDBACK,
                                               state=MediaObject.State.VALIDATED).first()
            if voice is None or Feedback.objects.filter(voice=voice).exists():
                raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"voice": ["الملاحظة الصوتية غير صالحة."]})
        with transaction.atomic():
            s = Submission.objects.select_for_update().filter(pk=pk, student_id__in=assigned_student_ids(request.user)).first()
            if s is None:
                raise NOT_FOUND
            if Feedback.objects.filter(submission=s).exists():
                raise ApiError("already_reviewed", "تمت مراجعة هذا التسليم من قبل.", 409)
            a = Assignment.objects.select_for_update().get(pk=s.assignment_id)
            if a.status != AssignmentStatus.SUBMITTED or Submission.objects.filter(assignment=a, attempt__gt=s.attempt).exists():
                raise ApiError("not_latest", "يوجد تسليم أحدث لهذه المهمة.", 409)
            fb = Feedback.objects.create(submission=s, teacher=request.user, score_hifz=d["score_hifz"], score_tajweed=d["score_tajweed"],
                                         score_fluency=d["score_fluency"], decision=d["decision"], general=d["general"].strip(),
                                         needs_review=d["needs_review"].strip(), next_step=d["next_step"].strip(), voice=voice)
            FeedbackNote.objects.bulk_create([FeedbackNote(feedback=fb, at_seconds=min(n["at_seconds"], s.duration_seconds or n["at_seconds"]),
                                                            text=n["text"].strip(), category=n["category"]) for n in d["notes"]])
            services.transition(a, AssignmentStatus.ACCEPTED if d["decision"] == "accept" else AssignmentStatus.NEEDS_REPEAT, actor=request.user)
            # Spaced repetition: accepted memorization starts a schedule; a reviewed review task moves it.
            from . import reviews
            if d["decision"] == "accept":
                reviews.on_hifz_accepted(a, request.user)
            reviews.on_review_feedback(a, fb, request.user)
            student, title, sid = s.student, a.title, s.pk
            transaction.on_commit(lambda: notify(student, "feedback_new", "وصل تقييم معلمك", title, link=f"/feedback/{sid}", dedupe=f"feedback:{sid}",
                                                         data={"submission": sid, "assignment": a.pk}))
        audit("feedback.created", actor=request.user, target=fb, request=request, decision=fb.decision)
        return Response(services.submission_out(_submissions(request.user).get(pk=s.pk), request.user, request), status=201)


# ---- Lesson library (Prompt 09) ---------------------------------------------------------
from .models import Course, Lesson, LessonCompletion, PublishState  # noqa: E402

TOPIC_LABELS = {"tajweed": "التجويد", "hifz": "الحفظ والمراجعة", "adab": "آداب التلاوة", "ulum": "علوم القرآن"}


def _published_lessons(user=None):
    """Published lessons of published courses that `user` may read (restricted courses need an active enrollment)."""
    qs = Lesson.objects.filter(state=PublishState.PUBLISHED, course__state=PublishState.PUBLISHED).select_related("course", "media")
    if user is not None:
        qs = qs.filter(Q(course__restricted=False) | Q(course__teacher=user)
                       | Q(course__enrollments__student=user, course__enrollments__status="active")).distinct()
    return qs


def _lesson_out(l: Lesson, done: set, request, full=False) -> dict:
    from apps.media import services as media_services

    out = {"id": l.id, "title": l.title, "kind": l.kind, "course": l.course_id, "course_title": l.course.title, "topic": l.course.topic,
           "topic_label": TOPIC_LABELS.get(l.course.topic, l.course.topic), "level": l.course.level or "جميع المستويات",
           "duration_minutes": l.duration_minutes, "order": l.order, "completed": l.id in done}
    if full:
        out["body"] = l.body
        out["external_url"] = l.external_url
        out["media"] = media_services.read_url(l.media, request) if l.media and l.media.state == "validated" else None
    return out


class LessonList(APIView):
    """Published lessons of published courses — the shared library for learners. `?topic=`."""

    permission_classes = [IsLearningUser]

    def get(self, request):
        qs = _published_lessons(request.user).order_by("course__title", "order", "id")
        if request.query_params.get("topic"):
            qs = qs.filter(course__topic=request.query_params["topic"])
        done = set(LessonCompletion.objects.filter(student=request.user).values_list("lesson_id", flat=True))
        return Response([_lesson_out(l, done, request) for l in qs[:200]])


class LessonDetail(APIView):
    permission_classes = [IsLearningUser]

    def get(self, request, pk):
        l = _published_lessons(request.user).filter(pk=pk).first()
        if l is None:
            raise NOT_FOUND
        done = set(LessonCompletion.objects.filter(student=request.user, lesson=l).values_list("lesson_id", flat=True))
        nxt = _published_lessons(request.user).filter(course=l.course).filter(Q(order__gt=l.order) | Q(order=l.order, id__gt=l.id)).order_by("order", "id").first()
        return Response({**_lesson_out(l, done, request, full=True), "next": {"id": nxt.id, "title": nxt.title} if nxt else None})


class LessonComplete(APIView):
    """Student marks a lesson complete (self-reported; not evidence of mastery). Idempotent."""

    permission_classes = [IsStudent]

    def post(self, request, pk):
        l = _published_lessons(request.user).filter(pk=pk).first()
        if l is None:
            raise NOT_FOUND
        LessonCompletion.objects.get_or_create(student=request.user, lesson=l)
        return Response({"id": l.id, "completed": True})
