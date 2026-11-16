"""API for weekly series, session participants and per-student evaluations (series.py has the rules).

Teacher:
  GET  teacher/series                         the teacher's series (active and paused first; cancelled within 30 days)
  POST teacher/series                         create (Idempotency-Key): {kind, students[], slots[{weekday,time,minutes}],
                                              topic, title, prep_note, meeting_url, starts_on, ends_on}
  GET/PATCH teacher/series/<id>               one series; edit title/topic/prep_note/meeting_url/ends_on/slots
  POST teacher/series/<id>/pause|resume|cancel
  POST teacher/series/<id>/participants       {student}
  DELETE teacher/series/<id>/participants/<student>
  POST teacher/sessions/<id>/participants     {student}   (one session)
  DELETE teacher/sessions/<id>/participants/<student>
  PUT  bookings/<id>/evaluation               the teacher of the session, once it has started
  GET  teacher/students/picker?q=             the teacher's assigned, active students (searchable)
Admin (sessions.view / sessions.manage): the same participant changes for any teacher's series or session, with any
active student (the admin's grant), plus the series list.
"""
from __future__ import annotations

from datetime import date, timedelta

from django.db.models import Q
from django.utils import timezone
from rest_framework import serializers
from rest_framework.generics import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import AccountStatus, Role, User
from apps.accounts.permissions import IsAdminRole, IsTeacher, assigned_student_ids
from apps.core.audit import audit
from apps.core.exceptions import ApiError

from . import series as S
from .models import Booking, RecurringSessionRule, SessionEvaluation, SessionOccurrence


def _date(v, field):
    if v in (None, ""):
        return None
    try:
        return date.fromisoformat(str(v))
    except ValueError:
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {field: ["تاريخ غير صالح."]}) from None


def series_out(rule: RecurringSessionRule, *, upcoming: int = 4) -> dict:
    from .meeting import LABELS

    now = timezone.now()
    nxt = (SessionOccurrence.objects.filter(series=rule, status=SessionOccurrence.Status.SCHEDULED, starts_at__gt=now)
           .order_by("starts_at")[:upcoming])
    parts = rule.participants.select_related("student").order_by("-active", "student__full_name")
    return {
        "id": rule.pk, "kind": rule.kind, "title": rule.title, "topic": rule.topic, "prep_note": rule.prep_note, "status": rule.status,
        "teacher": {"id": rule.teacher_id, "name": rule.teacher.display_name},
        "meeting_url": rule.meeting_url, "meeting_provider": rule.meeting_provider, "meeting_label": LABELS.get(rule.meeting_provider, ""),
        "timezone": rule.timezone, "starts_on": rule.starts_on.isoformat(), "ends_on": rule.ends_on.isoformat() if rule.ends_on else None,
        "slots": [{"id": s.pk, "weekday": s.weekday, "time": s.start_time.strftime("%H:%M"), "minutes": s.minutes} for s in rule.slots.filter(active=True)],
        "schedule_text": S.days_text(rule),
        "participants": [{"student": p.student_id, "name": p.student.full_name, "active": p.active,
                          "since": p.created_at.isoformat(), "ended_at": p.ended_at.isoformat() if p.ended_at else None} for p in parts],
        "next_sessions": [{"id": o.pk, "starts_at": o.starts_at.isoformat(), "ends_at": o.ends_at.isoformat()} for o in nxt],
    }


def _students_body(request) -> list:
    ids = request.data.get("students")
    if ids is None and request.data.get("student") is not None:
        ids = [request.data.get("student")]
    if isinstance(ids, list):
        ids = [int(i) if isinstance(i, str) and i.isdigit() else i for i in ids]
    return ids


def _one_student(request, *, teacher, by_admin: bool):
    sid = request.data.get("student")
    sid = int(sid) if isinstance(sid, str) and sid.isdigit() else sid
    return S.eligible_students(teacher, [sid], by_admin=by_admin)[0]


# ---- teacher ----------------------------------------------------------------------------------------------------
class TeacherStudentPicker(APIView):
    """The searchable list for «اختيار الطلاب»: only this teacher's assigned, active students."""

    permission_classes = [IsTeacher]

    def get(self, request):
        q = str(request.query_params.get("q", "")).strip()
        qs = User.objects.filter(pk__in=assigned_student_ids(request.user), role=Role.STUDENT, status=AccountStatus.ACTIVE)
        if q:
            qs = qs.filter(Q(full_name__icontains=q) | Q(email__icontains=q))
        return Response({"results": [{"id": u.pk, "name": u.full_name} for u in qs.order_by("full_name")[:200]]})


class TeacherSeriesList(APIView):
    permission_classes = [IsTeacher]

    def get(self, request):
        since = timezone.now() - timedelta(days=30)
        qs = (RecurringSessionRule.objects.filter(teacher=request.user)
              .filter(~Q(status=RecurringSessionRule.Status.CANCELLED) | Q(updated_at__gte=since)).select_related("teacher").order_by("status", "-created_at"))
        return Response({"results": [series_out(r) for r in qs[:50]]})

    def post(self, request):
        key = str(request.headers.get("Idempotency-Key") or request.data.get("request_id") or "")[:64]
        if len(key) < 8:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"request_id": ["معرّف الطلب مطلوب."]})
        prior = RecurringSessionRule.objects.filter(teacher=request.user, creation_key=key).first()
        if prior is not None:
            return Response({**series_out(prior), "result": None}, status=200)
        d = request.data
        topic = str(d.get("topic") or "")
        if topic and topic not in SessionOccurrence.Topic.values:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"topic": ["نوع غير صالح."]})
        students = S.eligible_students(request.user, _students_body(request))
        rule, result, created = S.create_series(
            teacher=request.user, by=request.user, kind=str(d.get("kind") or ""), students=students, slots=d.get("slots"), topic=topic,
            title=str(d.get("title") or ""), prep_note=str(d.get("prep_note") or ""), meeting_url=str(d.get("meeting_url") or ""),
            starts_on=_date(d.get("starts_on"), "starts_on"), ends_on=_date(d.get("ends_on"), "ends_on"), key=key)
        if created:
            audit("series.created", actor=request.user, target=rule, request=request, kind=rule.kind, students=[s.pk for s in students],
                  slots=len(rule.slots.all()), sessions=result["created"], conflicts=len(result["conflicts"]))
        return Response({**series_out(rule), "result": result}, status=201 if created else 200)


def _own_series(request, pk) -> RecurringSessionRule:
    r = RecurringSessionRule.objects.select_related("teacher").filter(pk=pk, teacher=request.user).first()
    if r is None:
        raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
    return r


class TeacherSeriesDetail(APIView):
    permission_classes = [IsTeacher]

    def get(self, request, pk):
        return Response(series_out(_own_series(request, pk), upcoming=12))

    def patch(self, request, pk):
        rule = _own_series(request, pk)
        result = S.update_series(rule, request.user, request.data)
        audit("series.updated", actor=request.user, target=rule, request=request, fields=sorted(k for k in request.data if k != "meeting_url"),
              link_changed="meeting_url" in request.data, **{k: v for k, v in result.items() if k != "conflicts"})
        rule.refresh_from_db()
        return Response({**series_out(rule, upcoming=12), "result": result})


class TeacherSeriesState(APIView):
    permission_classes = [IsTeacher]
    target = ""

    def post(self, request, pk):
        rule = _own_series(request, pk)
        n = S.set_status(rule, request.user, self.target, str(request.data.get("reason") or "").strip()[:200])
        audit(f"series.{self.target}", actor=request.user, target=rule, request=request, sessions_cancelled=n)
        rule.refresh_from_db()
        return Response({**series_out(rule), "sessions_cancelled": n})


class TeacherSeriesPause(TeacherSeriesState):
    target = RecurringSessionRule.Status.PAUSED


class TeacherSeriesResume(TeacherSeriesState):
    target = RecurringSessionRule.Status.ACTIVE


class TeacherSeriesCancel(TeacherSeriesState):
    target = RecurringSessionRule.Status.CANCELLED


class TeacherSeriesParticipants(APIView):
    permission_classes = [IsTeacher]

    def post(self, request, pk):
        rule = _own_series(request, pk)
        student = _one_student(request, teacher=request.user, by_admin=False)
        r = S.add_participant(rule, student, request.user)
        audit("series.participant_added", actor=request.user, target=rule, request=request, student=student.pk, **{k: v for k, v in r.items() if k != "participant"})
        rule.refresh_from_db()
        return Response({**series_out(rule), "result": r}, status=201)


class TeacherSeriesParticipantDetail(APIView):
    permission_classes = [IsTeacher]

    def delete(self, request, pk, student):
        rule = _own_series(request, pk)
        st = get_object_or_404(User, pk=student, role=Role.STUDENT)
        r = S.remove_participant(rule, st, request.user, str(request.data.get("reason") or "") if hasattr(request, "data") else "")
        audit("series.participant_removed", actor=request.user, target=rule, request=request, student=st.pk, **r)
        rule.refresh_from_db()
        return Response({**series_out(rule), "result": r})


def _own_occurrence(request, pk) -> SessionOccurrence:
    o = SessionOccurrence.objects.filter(pk=pk, teacher=request.user).first()
    if o is None:
        raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
    return o


def session_participants_out(o: SessionOccurrence) -> dict:
    rows = Booking.objects.filter(occurrence=o).select_related("student").order_by("status", "student__full_name")
    return {"id": o.pk, "kind": o.kind, "capacity": o.capacity, "series": o.series_id,
            "participants": [{"booking": b.pk, "student": b.student_id, "name": b.student.full_name, "status": b.status,
                              "attendance": b.attendance} for b in rows]}


class TeacherSessionParticipants(APIView):
    permission_classes = [IsTeacher]

    def get(self, request, pk):
        return Response(session_participants_out(_own_occurrence(request, pk)))

    def post(self, request, pk):
        o = _own_occurrence(request, pk)
        student = _one_student(request, teacher=request.user, by_admin=False)
        b = S.add_to_session(o.pk, student, request.user)
        audit("session.participant_added", actor=request.user, target=o, request=request, student=student.pk, booking=b.pk)
        return Response(session_participants_out(o), status=201)


class TeacherSessionParticipantDetail(APIView):
    permission_classes = [IsTeacher]

    def delete(self, request, pk, student):
        o = _own_occurrence(request, pk)
        st = get_object_or_404(User, pk=student, role=Role.STUDENT)
        S.remove_from_session(o.pk, st, request.user)
        audit("session.participant_removed", actor=request.user, target=o, request=request, student=st.pk)
        return Response(session_participants_out(o))


# ---- evaluation -------------------------------------------------------------------------------------------------
class EvaluationIn(serializers.Serializer):
    memorization_grade = serializers.ChoiceField(choices=SessionEvaluation.Grade.choices, required=False, allow_blank=True, default="")
    surah = serializers.IntegerField(min_value=1, max_value=114, required=False, allow_null=True, default=None)
    ayah_from = serializers.IntegerField(min_value=1, max_value=286, required=False, allow_null=True, default=None)
    ayah_to = serializers.IntegerField(min_value=1, max_value=286, required=False, allow_null=True, default=None)
    tajweed_grade = serializers.ChoiceField(choices=SessionEvaluation.Grade.choices, required=False, allow_blank=True, default="")
    tajweed_note = serializers.CharField(max_length=300, required=False, allow_blank=True, default="")
    note = serializers.CharField(max_length=1000, required=False, allow_blank=True, default="")

    def validate(self, d):
        from apps.quran.reference import ayah_count

        if d.get("ayah_from") or d.get("ayah_to"):
            if not d.get("surah"):
                raise serializers.ValidationError({"surah": ["اختر السورة."]})
        if d.get("surah"):
            n = ayah_count(d["surah"])
            a, b = d.get("ayah_from"), d.get("ayah_to")
            if n is not None and ((a and a > n) or (b and b > n)):
                raise serializers.ValidationError({"ayah_to": [f"عدد آيات السورة {n}."]})
            if a and b and b < a:
                raise serializers.ValidationError({"ayah_to": ["آية النهاية بعد آية البداية."]})
        if not any([d.get("memorization_grade"), d.get("surah"), d.get("tajweed_grade"), d.get("tajweed_note", "").strip(), d.get("note", "").strip()]):
            raise serializers.ValidationError({"note": ["أدخل تقييمًا أو ملاحظة."]})
        return d


def evaluation_out(ev: SessionEvaluation | None) -> dict | None:
    if ev is None:
        return None
    return {"memorization_grade": ev.memorization_grade, "memorization_label": ev.get_memorization_grade_display() if ev.memorization_grade else "",
            "surah": ev.surah, "ayah_from": ev.ayah_from, "ayah_to": ev.ayah_to,
            "tajweed_grade": ev.tajweed_grade, "tajweed_label": ev.get_tajweed_grade_display() if ev.tajweed_grade else "",
            "tajweed_note": ev.tajweed_note, "note": ev.note, "updated_at": ev.updated_at.isoformat()}


def booking_evaluation(b) -> dict | None:
    try:
        return evaluation_out(b.evaluation)
    except SessionEvaluation.DoesNotExist:
        return None


class BookingEvaluation(APIView):
    """PUT: the session's teacher records this student's memorization progress, grades and note (after the start).
    Each student of a group session has their own; a correction overwrites it and is audited."""

    permission_classes = [IsTeacher]

    def put(self, request, pk):
        from django.db import transaction

        b = Booking.objects.select_related("occurrence", "student").filter(pk=pk, occurrence__teacher=request.user, status="confirmed").first()
        if b is None:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        if b.occurrence.starts_at > timezone.now():
            raise ApiError("not_started", "يُسجَّل التقييم بعد بدء الجلسة.", 409)
        s = EvaluationIn(data=request.data)
        s.is_valid(raise_exception=True)
        with transaction.atomic():
            ev, created = SessionEvaluation.objects.select_for_update().get_or_create(booking=b, defaults={"evaluated_by": request.user})
            for k, v in s.validated_data.items():
                setattr(ev, k, v.strip() if isinstance(v, str) else v)
            ev.evaluated_by = request.user
            ev.save()
            audit("session.evaluation_saved", actor=request.user, target=b, request=request, created=created, student=b.student_id)
            if created:
                from apps.notifications.services import after_commit

                after_commit(b.student, "session_evaluated", "تقييم جلستك", f"سجّل {request.user.display_name} تقييمك في الجلسة.",
                             link=f"/sessions/{b.pk}", dedupe=f"booking:{b.pk}:evaluated", data={"booking": b.pk})
        return Response(evaluation_out(ev))


# ---- admin ------------------------------------------------------------------------------------------------------
class AdminSeries(APIView):
    permission_classes = [IsAdminRole]
    admin_perm = "sessions.view"

    def get(self, request):
        qs = RecurringSessionRule.objects.select_related("teacher").order_by("status", "-created_at")
        t = request.query_params.get("teacher")
        if t and str(t).isdigit():
            qs = qs.filter(teacher_id=int(t))
        st = request.query_params.get("status")
        if st:
            qs = qs.filter(status=st)
        return Response({"results": [series_out(r) for r in qs[:100]]})


class AdminSeriesDetail(APIView):
    permission_classes = [IsAdminRole]
    admin_perm = {"read": "sessions.view", "write": "sessions.manage"}

    def get(self, request, pk):
        return Response(series_out(get_object_or_404(RecurringSessionRule.objects.select_related("teacher"), pk=pk), upcoming=12))

    def post(self, request, pk):
        """{action: pause|resume|cancel, reason}"""
        rule = get_object_or_404(RecurringSessionRule.objects.select_related("teacher"), pk=pk)
        target = {"pause": "paused", "resume": "active", "cancel": "cancelled"}.get(str(request.data.get("action")))
        if target is None:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"action": ["إجراء غير صالح."]})
        reason = str(request.data.get("reason") or "").strip()[:200]
        n = S.set_status(rule, request.user, target, reason)
        audit(f"admin.series_{target}", actor=request.user, target=rule, request=request, sessions_cancelled=n, reason=reason)
        rule.refresh_from_db()
        return Response({**series_out(rule), "sessions_cancelled": n})


class AdminSeriesParticipants(APIView):
    """POST {student}: any active student (the admin's explicit grant, even if not assigned to the teacher)."""

    permission_classes = [IsAdminRole]
    admin_perm = "sessions.manage"

    def post(self, request, pk):
        rule = get_object_or_404(RecurringSessionRule.objects.select_related("teacher"), pk=pk)
        student = _one_student(request, teacher=rule.teacher, by_admin=True)
        r = S.add_participant(rule, student, request.user, by_admin=True)
        from apps.accounts.models import TeacherAssignment

        audit("admin.series_participant_added", actor=request.user, target=rule, request=request, student=student.pk,
              assigned=TeacherAssignment.objects.filter(teacher=rule.teacher, student=student, active=True).exists())
        rule.refresh_from_db()
        return Response({**series_out(rule), "result": r}, status=201)


class AdminSeriesParticipantDetail(APIView):
    permission_classes = [IsAdminRole]
    admin_perm = "sessions.manage"

    def delete(self, request, pk, student):
        rule = get_object_or_404(RecurringSessionRule.objects.select_related("teacher"), pk=pk)
        st = get_object_or_404(User, pk=student, role=Role.STUDENT)
        r = S.remove_participant(rule, st, request.user, "أزالته الإدارة")
        audit("admin.series_participant_removed", actor=request.user, target=rule, request=request, student=st.pk, **r)
        rule.refresh_from_db()
        return Response({**series_out(rule), "result": r})


class AdminSessionParticipants(APIView):
    permission_classes = [IsAdminRole]
    admin_perm = {"read": "sessions.view", "write": "sessions.manage"}

    def get(self, request, pk):
        return Response(session_participants_out(get_object_or_404(SessionOccurrence, pk=pk)))

    def post(self, request, pk):
        o = get_object_or_404(SessionOccurrence.objects.select_related("teacher"), pk=pk)
        student = _one_student(request, teacher=o.teacher, by_admin=True)
        b = S.add_to_session(o.pk, student, request.user)
        audit("admin.session_participant_added", actor=request.user, target=o, request=request, student=student.pk, booking=b.pk)
        return Response(session_participants_out(o), status=201)


class AdminSessionParticipantDetail(APIView):
    permission_classes = [IsAdminRole]
    admin_perm = "sessions.manage"

    def delete(self, request, pk, student):
        o = get_object_or_404(SessionOccurrence, pk=pk)
        st = get_object_or_404(User, pk=student, role=Role.STUDENT)
        S.remove_from_session(o.pk, st, request.user, "أزالته الإدارة")
        audit("admin.session_participant_removed", actor=request.user, target=o, request=request, student=st.pk)
        return Response(session_participants_out(o))


def urls():
    from django.urls import path

    return [
        path("teacher/students/picker", TeacherStudentPicker.as_view()),
        path("teacher/series", TeacherSeriesList.as_view()),
        path("teacher/series/<int:pk>", TeacherSeriesDetail.as_view()),
        path("teacher/series/<int:pk>/pause", TeacherSeriesPause.as_view()),
        path("teacher/series/<int:pk>/resume", TeacherSeriesResume.as_view()),
        path("teacher/series/<int:pk>/cancel", TeacherSeriesCancel.as_view()),
        path("teacher/series/<int:pk>/participants", TeacherSeriesParticipants.as_view()),
        path("teacher/series/<int:pk>/participants/<int:student>", TeacherSeriesParticipantDetail.as_view()),
        path("teacher/sessions/<int:pk>/participants", TeacherSessionParticipants.as_view()),
        path("teacher/sessions/<int:pk>/participants/<int:student>", TeacherSessionParticipantDetail.as_view()),
        path("bookings/<int:pk>/evaluation", BookingEvaluation.as_view()),
        path("admin/series", AdminSeries.as_view()),
        path("admin/series/<int:pk>", AdminSeriesDetail.as_view()),
        path("admin/series/<int:pk>/participants", AdminSeriesParticipants.as_view()),
        path("admin/series/<int:pk>/participants/<int:student>", AdminSeriesParticipantDetail.as_view()),
        path("admin/sessions/<int:pk>/participants", AdminSessionParticipants.as_view()),
        path("admin/sessions/<int:pk>/participants/<int:student>", AdminSessionParticipantDetail.as_view()),
    ]
