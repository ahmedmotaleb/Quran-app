"""Admin portal: circles (recurring group classes), their sessions, and booking oversight (pack prompt 06).

Reuses Circle / SessionOccurrence / Booking and their database constraints; nothing here bypasses the booking
locks. Every change is audited; cancellations keep history and notify affected students.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from django.db import IntegrityError, transaction
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import serializers
from rest_framework.generics import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import Role, User
from apps.accounts.permissions import IsAdminRole
from apps.core.audit import audit
from apps.core.bulk import list_with
from apps.core.exceptions import ApiError
from apps.core.models import AppSettings
from apps.core.pagination import StandardPagination

from . import services
from .models import Booking, Circle, SessionOccurrence


def _page(view, request, qs, fn):
    p = StandardPagination()
    return p.get_paginated_response([fn(x) for x in p.paginate_queryset(qs, request, view=view)])


def _reason(request, required=True) -> str:
    r = str(request.data.get("reason", "")).strip()[:200]
    if required and len(r) < 3:
        raise ApiError("invalid", "اكتب سبب الإجراء.", 400, {"reason": ["اكتب سبب الإجراء (3 أحرف على الأقل)."]})
    return r


class AdminView(APIView):
    permission_classes = [IsAdminRole]


# ---- Circles --------------------------------------------------------------------------
class CircleIn(serializers.Serializer):
    name = serializers.CharField(min_length=2, max_length=120)
    teacher = serializers.PrimaryKeyRelatedField(queryset=User.objects.filter(role=Role.TEACHER))
    level = serializers.CharField(max_length=32, required=False, allow_blank=True)
    capacity = serializers.IntegerField(min_value=2, max_value=40)
    schedule_note = serializers.CharField(max_length=120, required=False, allow_blank=True)


def _circles():
    now = timezone.now()
    upcoming = Q(occurrences__status=SessionOccurrence.Status.SCHEDULED, occurrences__starts_at__gte=now)
    return Circle.objects.select_related("teacher").annotate(
        upcoming=Count("occurrences", filter=upcoming, distinct=True),
        booked=Count("occurrences__bookings", filter=upcoming & Q(occurrences__bookings__status=Booking.Status.CONFIRMED), distinct=True))


def _circle_out(c: Circle) -> dict:
    return {"id": c.id, "name": c.name, "teacher": {"id": c.teacher_id, "name": c.teacher.full_name}, "level": c.level,
            "capacity": c.capacity, "schedule_note": c.schedule_note, "state": c.state,
            "upcoming_sessions": getattr(c, "upcoming", None), "upcoming_booked_seats": getattr(c, "booked", None),
            "updated_at": c.updated_at.isoformat()}


def _occ_out(o: SessionOccurrence) -> dict:
    return {"id": o.id, "starts_at": o.starts_at.isoformat(), "ends_at": o.ends_at.isoformat(), "status": o.status,
            "capacity": o.capacity, "booked": getattr(o, "booked", None), "kind": o.kind,
            "teacher": {"id": o.teacher_id, "name": o.teacher.full_name}}


class AdminCircles(AdminView):
    def get(self, request):
        from .admin_bulk import CIRCLE_FILTERS

        return list_with(self, request, _circles(), CIRCLE_FILTERS, _circle_out)

    def post(self, request):
        s = CircleIn(data=request.data)
        s.is_valid(raise_exception=True)
        c = Circle.objects.create(**s.validated_data)  # always a draft first
        audit("admin.circle_created", actor=request.user, target=c, request=request, name=c.name)
        return Response(_circle_out(_circles().get(pk=c.pk)), status=201)


class AdminCircleDetail(AdminView):
    def get(self, request, pk):
        c = get_object_or_404(_circles(), pk=pk)
        occ = (c.occurrences.filter(starts_at__gte=timezone.now() - timedelta(days=1)).select_related("teacher")
               .annotate(booked=Count("bookings", filter=Q(bookings__status=Booking.Status.CONFIRMED))).order_by("starts_at")[:40])
        return Response({**_circle_out(c), "sessions": [_occ_out(o) for o in occ]})

    def patch(self, request, pk):
        c = get_object_or_404(Circle, pk=pk)
        s = CircleIn(data=request.data, partial=True)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        if "teacher" in d and d["teacher"].pk != c.teacher_id and c.occurrences.filter(
                status=SessionOccurrence.Status.SCHEDULED, starts_at__gte=timezone.now()).exists():
            raise ApiError("has_sessions", "للحلقة جلسات قادمة مع المعلم الحالي. ألغها أولًا ثم غيّر المعلم.", 409)
        with transaction.atomic():
            if "capacity" in d and d["capacity"] != c.capacity:
                # Never below seats already taken in an upcoming session.
                fut = c.occurrences.filter(status=SessionOccurrence.Status.SCHEDULED, starts_at__gte=timezone.now()) \
                    .annotate(n=Count("bookings", filter=Q(bookings__status=Booking.Status.CONFIRMED)))
                most = max((o.n for o in fut), default=0)
                if d["capacity"] < most:
                    raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"capacity": [f"لا تقل عن عدد المحجوز ({most})."]})
                fut.update(capacity=d["capacity"])
            for k, v in d.items():
                setattr(c, k, v)
            c.save()
        audit("admin.circle_updated", actor=request.user, target=c, request=request, fields=sorted(d))
        return Response(_circle_out(_circles().get(pk=c.pk)))


class AdminCircleState(AdminView):
    """draft → published (visible and bookable) → off (hidden; existing bookings stay until cancelled)."""

    def post(self, request, pk):
        c = get_object_or_404(Circle.objects.select_related("teacher__teacher_profile"), pk=pk)
        new = request.data.get("state")
        if new not in Circle.State.values:
            raise ApiError("invalid", "حالة غير صالحة.", 400, {"state": ["اختر حالة صالحة."]})
        if new == Circle.State.PUBLISHED:
            prof = getattr(c.teacher, "teacher_profile", None)
            if not prof or not prof.approved_at or c.teacher.status != "active":
                raise ApiError("teacher_not_approved", "اعتمد معلم الحلقة أولًا.", 409)
        old = c.state
        c.state = new
        c.save(update_fields=["state", "updated_at"])
        audit("admin.circle_state", actor=request.user, target=c, request=request, old=old, new=new,
              reason=_reason(request, required=new == Circle.State.OFF))
        return Response(_circle_out(_circles().get(pk=c.pk)))


class SessionsIn(serializers.Serializer):
    weekday = serializers.IntegerField(min_value=0, max_value=6)  # 0 = Monday … 6 = Sunday
    time = serializers.TimeField()  # local time in `timezone`
    minutes = serializers.IntegerField(min_value=15, max_value=240)
    weeks = serializers.IntegerField(min_value=1, max_value=26)
    start = serializers.DateField(required=False)
    timezone = serializers.CharField(required=False)
    dry_run = serializers.BooleanField(default=False)

    def validate_timezone(self, v):
        try:
            ZoneInfo(v)
        except Exception:  # noqa: BLE001
            raise serializers.ValidationError("منطقة زمنية غير معروفة.") from None
        return v


class AdminCircleSessions(AdminView):
    """Schedule weekly sessions for a circle. Times are local (DST-safe). `dry_run` previews without saving.
    Unbooked individual open slots of the teacher at those times are replaced; anything booked is a conflict."""

    def post(self, request, pk):
        c = get_object_or_404(Circle, pk=pk)
        s = SessionsIn(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        tz = ZoneInfo(d.get("timezone") or c.teacher.timezone or AppSettings.load().default_timezone)
        start: date = d.get("start") or timezone.localdate()
        first = start + timedelta(days=(d["weekday"] - start.weekday()) % 7)
        now = timezone.now()
        plan, created, replaced = [], 0, 0
        for i in range(d["weeks"]):
            st = datetime.combine(first + timedelta(weeks=i), d["time"], tzinfo=tz)
            en = st + timedelta(minutes=d["minutes"])
            item = {"starts_at": st.isoformat(), "ends_at": en.isoformat(), "ok": True, "problem": ""}
            clash = SessionOccurrence.objects.filter(teacher=c.teacher, starts_at__lt=en, ends_at__gt=st).exclude(status=SessionOccurrence.Status.CANCELLED)
            busy = clash.filter(Q(circle__isnull=False) | Q(bookings__status=Booking.Status.CONFIRMED)).distinct()
            if st <= now:
                item.update(ok=False, problem="وقت مضى")
            elif busy.exists():
                item.update(ok=False, problem="المعلم لديه جلسة محجوزة أو حلقة أخرى في هذا الوقت")
            plan.append(item)
            if d["dry_run"] or not item["ok"]:
                continue
            try:
                with transaction.atomic():
                    replaced += clash.exclude(pk__in=busy.values("pk")).update(status=SessionOccurrence.Status.CANCELLED, updated_at=now)
                    SessionOccurrence.objects.create(teacher=c.teacher, kind=SessionOccurrence.Kind.GROUP, circle=c,
                                                     starts_at=st, ends_at=en, capacity=c.capacity)
                    created += 1
            except IntegrityError:  # a concurrent change took the time
                item.update(ok=False, problem="تعارض مع جلسة أُضيفت للتو")
        if not d["dry_run"]:
            audit("admin.circle_sessions", actor=request.user, target=c, request=request, created=created, replaced_open_slots=replaced,
                  weekday=d["weekday"], time=str(d["time"]), weeks=d["weeks"])
        return Response({"dry_run": d["dry_run"], "created": created, "replaced_open_slots": replaced, "timezone": str(tz), "plan": plan},
                        status=200 if d["dry_run"] else 201)


class AdminOccurrenceCancel(AdminView):
    def post(self, request, pk):
        reason = _reason(request)
        o, n = services.cancel_occurrence(occurrence_id=pk, by=request.user, reason=reason)
        audit("admin.session_cancelled", actor=request.user, target=o, request=request, bookings_cancelled=n, reason=reason)
        return Response({"id": o.id, "status": o.status, "bookings_cancelled": n})


# ---- Bookings -------------------------------------------------------------------------
def _booking_out(b: Booking) -> dict:
    o = b.occurrence
    return {"id": b.id, "status": b.status, "attendance": b.attendance, "starts_at": o.starts_at.isoformat(), "ends_at": o.ends_at.isoformat(),
            "kind": o.kind, "circle": o.circle.name if o.circle_id else None, "session_status": o.status,
            "teacher": {"id": o.teacher_id, "name": o.teacher.full_name}, "student": {"id": b.student_id, "name": b.student.full_name},
            "cancel_reason": b.cancel_reason, "cancelled_at": b.cancelled_at.isoformat() if b.cancelled_at else None,
            "cancelled_by": b.cancelled_by.full_name if b.cancelled_by_id else None, "created_at": b.created_at.isoformat()}


class AdminBookings(AdminView):
    def get(self, request):
        from .admin_bulk import BOOKING_FILTERS

        p = request.query_params
        # Past bookings default to newest first; upcoming ones to soonest first.
        sort = p.get("sort") or ("-starts" if p.get("when") == "past" else "starts")
        qs = BOOKING_FILTERS.run(Booking.objects.select_related("occurrence__teacher", "occurrence__circle", "student", "cancelled_by"), p, sort=sort)
        return _page(self, request, qs, _booking_out)


class AdminBookingCounts(AdminView):
    def get(self, request):
        now = timezone.now()
        up = Booking.objects.filter(occurrence__starts_at__gte=now)
        return Response({"upcoming_confirmed": up.filter(status=Booking.Status.CONFIRMED).count(),
                         "upcoming_cancelled": up.filter(status=Booking.Status.CANCELLED).count(),
                         "today": Booking.objects.filter(status=Booking.Status.CONFIRMED, occurrence__starts_at__gte=now,
                                                         occurrence__starts_at__lt=now + timedelta(hours=24)).count()})


class AdminBookingCancel(AdminView):
    def post(self, request, pk):
        reason = _reason(request)
        get_object_or_404(Booking, pk=pk)
        b = services.cancel(booking_id=pk, by=request.user, reason=reason)  # same locks as everyone else; notifies the student
        audit("admin.booking_cancelled", actor=request.user, target=b, request=request, reason=reason)
        b = Booking.objects.select_related("occurrence__teacher", "occurrence__circle", "student", "cancelled_by").get(pk=b.pk)
        return Response(_booking_out(b))
