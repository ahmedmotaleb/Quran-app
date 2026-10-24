from datetime import timedelta

from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import generics
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import Role
from apps.accounts.permissions import IsLearningUser, IsStudent, IsTeacher, scope_by_student
from apps.core.audit import audit
from apps.core.exceptions import ApiError
from apps.core.models import AppSettings
from apps.learning.models import Assignment

from . import services
from .models import Booking, SessionOccurrence
from .serializers import AttendanceSerializer, BookingCreateSerializer, BookingSerializer, SlotSerializer


class TeacherSlots(generics.ListAPIView):
    """Open slots for one teacher within the booking window. Seat counts come from the database."""

    permission_classes = [IsLearningUser]
    serializer_class = SlotSerializer
    pagination_class = None

    def get_queryset(self):
        cfg = AppSettings.load()
        now = timezone.now()
        qs = (SessionOccurrence.objects.filter(
            teacher_id=self.kwargs["pk"], status=SessionOccurrence.Status.SCHEDULED,
            teacher__teacher_profile__approved_at__isnull=False,
            starts_at__gte=now + timedelta(minutes=cfg.booking_lead_minutes), starts_at__lte=now + timedelta(days=cfg.booking_horizon_days))
            .filter(Q(circle__isnull=True) | Q(circle__state="published"))
            .select_related("teacher", "circle")
            .annotate(confirmed_count=Count("bookings", filter=Q(bookings__status=Booking.Status.CONFIRMED), distinct=True),
                      # seats offered to waiting students are held for them (waitlist.py)
                      held_count=Count("waitlist", filter=Q(waitlist__status="offered", waitlist__offer_expires_at__gt=now), distinct=True))
            .order_by("starts_at"))
        return qs


class BookingScopeMixin:
    """Bookings visible to the caller: own (student), linked children (parent), own sessions (teacher), all (admin)."""

    def get_queryset(self):
        u = self.request.user
        qs = Booking.objects.select_related("occurrence__teacher", "student", "excuse")
        if u.role == Role.TEACHER:
            qs = qs.filter(occurrence__teacher=u)
        else:
            qs = scope_by_student(qs, u)
        status = self.request.query_params.get("status")
        if status:
            qs = qs.filter(status=status)
        when = self.request.query_params.get("when")
        now = timezone.now()
        if when == "upcoming":
            qs = qs.filter(occurrence__ends_at__gte=now).order_by("occurrence__starts_at")
        elif when == "past":
            qs = qs.filter(occurrence__ends_at__lt=now).order_by("-occurrence__starts_at")
        else:
            qs = qs.order_by("-occurrence__starts_at")
        return qs

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        cfg, now = AppSettings.load(), timezone.now()
        ctx["joinable"] = set(Booking.objects.filter(
            status="confirmed", occurrence__starts_at__lte=now + timedelta(minutes=cfg.join_minutes), occurrence__ends_at__gte=now,
        ).exclude(occurrence__status=SessionOccurrence.Status.CANCELLED).values_list("pk", flat=True))
        return ctx


class BookingList(BookingScopeMixin, generics.ListCreateAPIView):
    permission_classes = [IsLearningUser]
    throttle_scope = "booking"
    serializer_class = BookingSerializer

    def create(self, request, *args, **kwargs):
        if request.user.role != Role.STUDENT:
            raise ApiError("permission_denied", "ليست لديك صلاحية لهذا الإجراء.", 403)
        s = BookingCreateSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        assignment = None
        if d.get("assignment"):
            assignment = Assignment.objects.filter(pk=d["assignment"], student=request.user).first()
            if assignment is None:
                raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"assignment": ["مهمة غير صالحة."]})
        key = request.headers.get("Idempotency-Key", "")
        booking, created = services.book(student=request.user, occurrence_id=d["occurrence"], idempotency_key=key, assignment=assignment, note=d["note"],
                                         makeup_credit_id=d.get("makeup_credit"))
        if created:
            audit("booking.created", actor=request.user, target=booking, request=request)
        return Response(BookingSerializer(booking, context=self.get_serializer_context()).data, status=201 if created else 200)


class BookingDetail(BookingScopeMixin, generics.RetrieveAPIView):
    permission_classes = [IsLearningUser]
    serializer_class = BookingSerializer


class BookingCancel(BookingScopeMixin, APIView):
    permission_classes = [IsLearningUser]

    def post(self, request, pk):
        # Visibility first: a booking the caller cannot see is reported as not found.
        if not self.get_queryset().filter(pk=pk).exists():
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        b = services.cancel(booking_id=pk, by=request.user, reason=str(request.data.get("reason", "")))
        audit("booking.cancelled", actor=request.user, target=b, request=request)
        return Response(BookingSerializer(b).data)


class BookingReschedule(APIView):
    permission_classes = [IsStudent]

    def post(self, request, pk):
        new_id = request.data.get("occurrence")
        if not isinstance(new_id, int):
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"occurrence": ["اختر موعدًا."]})
        b = services.reschedule(booking_id=pk, new_occurrence_id=new_id, by=request.user, idempotency_key=request.headers.get("Idempotency-Key", ""))
        audit("booking.rescheduled", actor=request.user, target=b, request=request, from_booking=pk)
        return Response(BookingSerializer(b).data)


class BookingAttendance(APIView):
    """Teacher marks attendance after the session starts. Corrections are audited."""

    permission_classes = [IsTeacher]

    def post(self, request, pk):
        b = Booking.objects.select_related("occurrence").filter(pk=pk, occurrence__teacher=request.user, status="confirmed").first()
        if b is None:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        if b.occurrence.starts_at > timezone.now():
            raise ApiError("not_started", "لا يمكن تسجيل الحضور قبل بدء الجلسة.", 409)
        s = AttendanceSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        from django.db import transaction as tx

        from . import excuses
        with tx.atomic():  # the mark and the absence rule (warnings / suspension) succeed or fail together
            b = Booking.objects.select_for_update().select_related("occurrence").get(pk=b.pk)
            old = b.attendance
            excuses.mark_attendance(b, s.validated_data["attendance"], request.user)
            audit("booking.attendance", actor=request.user, target=b, request=request, old=old, new=b.attendance)
        if b.attendance != old:
            from .services import notify_attendance
            tx.on_commit(lambda: notify_attendance(b.pk))
        return Response(BookingSerializer(b).data)


# ---- Teacher's own schedule ------------------------------------------------------------
from django.db import IntegrityError, transaction  # noqa: E402
from django.db.models import Prefetch  # noqa: E402

from .serializers import OpenSlotSerializer, TeacherOccurrenceSerializer  # noqa: E402


class TeacherOccurrences(APIView):
    """GET: the teacher's sessions from 7 days ago until `?days=` ahead (default 7, max 31).
    POST: open one individual slot. The database refuses overlaps with the teacher's other sessions."""

    permission_classes = [IsTeacher]

    def get(self, request):
        try:
            days = min(31, max(1, int(request.query_params.get("days", 7))))
        except ValueError:
            days = 7
        # The past week too, so attendance can still be recorded for recent sessions.
        today = timezone.localtime().replace(hour=0, minute=0, second=0, microsecond=0)
        qs = (SessionOccurrence.objects.filter(teacher=request.user, starts_at__gte=today - timedelta(days=7), starts_at__lt=today + timedelta(days=days + 1))
              .exclude(status=SessionOccurrence.Status.CANCELLED)
              .select_related("circle", "google_event", "google_event__student")
              .prefetch_related(Prefetch("bookings", queryset=Booking.objects.select_related("student", "assignment", "excuse")))
              .order_by("starts_at"))
        return Response(TeacherOccurrenceSerializer(qs, many=True).data)

    def post(self, request):
        s = OpenSlotSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        start = s.validated_data["starts_at"].replace(second=0, microsecond=0)
        cfg = AppSettings.load()
        now = timezone.now()
        if start < now + timedelta(minutes=cfg.booking_lead_minutes) or start > now + timedelta(days=cfg.booking_horizon_days):
            raise ApiError("outside_window", "لا يمكن فتح موعد في هذا الوقت.", 400, {"starts_at": ["اختر وقتًا ضمن نافذة الحجز."]})
        try:
            with transaction.atomic():
                o = SessionOccurrence.objects.create(teacher=request.user, starts_at=start, ends_at=start + timedelta(minutes=s.validated_data["minutes"]), capacity=1)
        except IntegrityError:
            raise ApiError("overlap", "يتعارض هذا الموعد مع جلسة أخرى لديك.", 409) from None
        audit("occurrence.opened", actor=request.user, target=o, request=request)
        return Response(TeacherOccurrenceSerializer(o).data, status=201)


class TeacherOccurrenceClose(APIView):
    """Close an open slot. Booked sessions must be cancelled per booking first (students are notified there)."""

    permission_classes = [IsTeacher]

    def post(self, request, pk):
        with transaction.atomic():
            o = SessionOccurrence.objects.select_for_update().filter(pk=pk, teacher=request.user).first()
            if o is None:
                raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
            if o.bookings.filter(status=Booking.Status.CONFIRMED).exists():
                raise ApiError("has_bookings", "لا يمكن إغلاق موعد محجوز؛ ألغِ الحجز أولًا.", 409)
            if o.starts_at <= timezone.now():
                raise ApiError("already_started", "لا يمكن إغلاق موعد بدأ أو انتهى.", 409)
            o.status = SessionOccurrence.Status.CANCELLED
            o.save(update_fields=["status", "updated_at"])
        audit("occurrence.closed", actor=request.user, target=o, request=request)
        return Response(status=204)


class TeacherOccurrenceMeeting(APIView):
    """PUT {url}: the teacher sets (or with "" clears) the participant link of their own upcoming session."""

    permission_classes = [IsTeacher]

    def put(self, request, pk):
        from .meeting import InvalidMeetingLink, provider_for

        url = str(request.data.get("url", "")).strip()
        provider = ""
        if url:
            try:
                provider = provider_for(url)
            except InvalidMeetingLink as e:
                raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"url": [str(e)]}) from None
        with transaction.atomic():
            o = SessionOccurrence.objects.select_for_update().filter(pk=pk, teacher=request.user).first()
            if o is None:
                raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
            if o.status == SessionOccurrence.Status.CANCELLED or o.ends_at <= timezone.now():
                raise ApiError("closed", "انتهت هذه الجلسة أو أُلغيت.", 409)
            if hasattr(o, "google_event"):
                raise ApiError("google_managed", "رابط Google Meet لهذه الجلسة يُنشأ تلقائيًا ولا يُعدَّل يدويًا.", 409)
            o.meeting_url, o.meeting_provider = url, provider
            o.save(update_fields=["meeting_url", "meeting_provider", "updated_at"])
        audit("occurrence.meeting_link_set" if url else "occurrence.meeting_link_cleared", actor=request.user, target=o, request=request,
              provider=provider)  # the link itself is not written to the audit log
        return Response(TeacherOccurrenceSerializer(o).data)


class BookingJoin(APIView):
    """POST: the booked student gets the session's participant link, only while the join window is open.
    Everyone else (parents, other students, a teacher of another session) gets 404; nothing is revealed."""

    permission_classes = [IsStudent]

    def post(self, request, pk):
        b = Booking.objects.select_related("occurrence").filter(pk=pk, student=request.user).first()
        if b is None:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        o, now, cfg = b.occurrence, timezone.now(), AppSettings.load()
        if b.status != Booking.Status.CONFIRMED or o.status == SessionOccurrence.Status.CANCELLED:
            raise ApiError("cancelled", "أُلغيت هذه الجلسة.", 409)
        if now > o.ends_at:
            raise ApiError("ended", "انتهت هذه الجلسة.", 409)
        opens = o.starts_at - timedelta(minutes=cfg.join_minutes)
        if now < opens:
            raise ApiError("too_early", f"يُفتح الدخول قبل الجلسة بـ {cfg.join_minutes} دقائق.", 409)
        if not o.meeting_url:
            raise ApiError("no_link", "لم يضف المعلم رابط الجلسة بعد. حاول بعد قليل.", 409)
        audit("booking.joined", actor=request.user, target=b, request=request, provider=o.meeting_provider)
        from .meeting import LABELS

        return Response({"url": o.meeting_url, "provider": o.meeting_provider, "provider_label": LABELS.get(o.meeting_provider, "")})


# ---- Excuses (owner decision 23 Oct 2026; rules in excuses.py) ----------------------------------
def excuse_out(ex, *, private: bool = True) -> dict:
    """`private`: the reason and the teacher's response (student, teacher, admin). Parents get the status only."""
    out = {"booking": ex.booking_id, "status": ex.status, "requested_at": ex.requested_at.isoformat(),
           "reviewed_at": ex.reviewed_at.isoformat() if ex.reviewed_at else None, "overridden": bool(ex.override_at)}
    if private:
        out.update(reason=ex.reason, teacher_response=ex.teacher_response)
    return out


class BookingExcuseCreate(APIView):
    """Student: «طلب اعتذار» for an own confirmed booking, before the deadline. One per booking."""

    permission_classes = [IsStudent]
    throttle_scope = "booking"

    def post(self, request, pk):
        from . import excuses

        ex, created = excuses.request_excuse(booking_id=pk, student=request.user, reason=str(request.data.get("reason", "")), request=request)
        return Response(excuse_out(ex), status=201 if created else 200)


class TeacherExcuseReview(APIView):
    """Teacher of the session: approve (response optional) or reject (response required)."""

    permission_classes = [IsTeacher]
    approve = True

    def post(self, request, pk):
        from . import excuses

        ex = excuses.review(booking_id=pk, teacher=request.user, approve=self.approve, response=str(request.data.get("response", "")), request=request)
        return Response(excuse_out(ex))


class TeacherExcuseApprove(TeacherExcuseReview):
    approve = True


class TeacherExcuseReject(TeacherExcuseReview):
    approve = False


def _excuse_rows(qs):
    return [{**excuse_out(ex), "student": {"id": ex.student_id, "name": ex.student.full_name},
             "teacher": {"id": ex.booking.occurrence.teacher_id, "name": ex.booking.occurrence.teacher.full_name},
             "starts_at": ex.booking.occurrence.starts_at.isoformat(), "kind": ex.booking.occurrence.kind,
             "attendance": ex.booking.attendance, "teacher_status": ex.teacher_status, "override_reason": ex.override_reason}
            for ex in qs.select_related("student", "booking__occurrence__teacher").order_by("requested_at")[:200]]


class TeacherExcuses(APIView):
    """GET ?status=pending (default) | approved | rejected | all — excuses for the teacher's own sessions."""

    permission_classes = [IsTeacher]

    def get(self, request):
        from .models import BookingExcuse

        qs = BookingExcuse.objects.filter(booking__occurrence__teacher=request.user)
        st = request.query_params.get("status", "pending")
        if st != "all":
            qs = qs.filter(status=st)
        return Response({"results": _excuse_rows(qs)})
