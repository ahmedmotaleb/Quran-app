"""Google Calendar connection (teachers) and teacher-created sessions backed by Google Calendar + Meet.

OAuth: authorization-code flow on the server. `connect` returns Google's consent URL with a signed, single-use,
10-minute `state` bound to the signed-in teacher; the callback accepts it only for that same signed-in teacher, so
nobody can attach their Google account to someone else's HALQA account (or the reverse). Tokens never reach the
browser, the logs or the audit trail.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.core import signing
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.http import HttpResponseRedirect
from django.utils import timezone
from rest_framework import serializers
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import AccountStatus, Role, User
from apps.accounts.permissions import IsAdminRole, IsTeacher, assigned_student_ids
from apps.core.audit import audit
from apps.core.exceptions import ApiError
from apps.scheduling.models import Circle, SessionOccurrence

from . import crypto, google, sync
from .google import GoogleError
from .models import GoogleCalendarConnection, GoogleEvent

STATE_SALT = "halqa.google.oauth"
STATE_AGE = 600
C = GoogleCalendarConnection.Status


def _mask(email: str) -> str:
    if "@" not in email:
        return ""
    name, dom = email.split("@", 1)
    return f"{name[:2]}{'•' * max(1, len(name) - 2)}@{dom}"


def status_out(teacher) -> dict:
    conn = GoogleCalendarConnection.objects.filter(teacher=teacher).first()
    state = "not_connected" if conn is None or conn.status == C.REVOKED else conn.status
    return {"configured": google.configured(), "status": state, "email": _mask(conn.google_account_email) if conn and state != "not_connected" else "",
            "connected_at": conn.connected_at.isoformat() if conn and conn.connected_at and state != "not_connected" else None}


class GoogleStatus(APIView):
    permission_classes = [IsTeacher]

    def get(self, request):
        return Response(status_out(request.user))


class GoogleConnect(APIView):
    """POST → {auth_url}: the app sends the teacher to Google's consent page («ربط» / «إعادة الربط»)."""

    permission_classes = [IsTeacher]

    def post(self, request):
        if not google.configured():
            raise ApiError("google_not_configured", sync.message("not_configured"), 503)
        nonce = secrets.token_urlsafe(24)
        cache.set(f"google-oauth:{nonce}", request.user.pk, STATE_AGE)
        state = signing.dumps({"t": request.user.pk, "n": nonce}, salt=STATE_SALT)
        return Response({"auth_url": google.auth_url(state)})


def _back(result: str) -> HttpResponseRedirect:
    base = settings.APP_URL or ""
    return HttpResponseRedirect(f"{base}/#/google?result={result}")


class GoogleCallback(APIView):
    """Google redirects the teacher's browser here with ?code&state (or ?error). Validates the signed state, its
    single use, its age and that the signed-in teacher is the one who started; then stores the encrypted refresh
    token and returns to the app. The code and tokens are never logged or put in a URL we build."""

    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def get(self, request):
        q = request.query_params
        try:
            data = signing.loads(q.get("state", ""), salt=STATE_SALT, max_age=STATE_AGE)
        except signing.BadSignature:
            return _back("invalid_state")
        teacher_id, nonce = data.get("t"), str(data.get("n", ""))
        if cache.get(f"google-oauth:{nonce}") != teacher_id:
            return _back("invalid_state")  # used already, expired, or forged
        cache.delete(f"google-oauth:{nonce}")
        u = request.user
        if not (u.is_authenticated and u.pk == teacher_id and u.role == Role.TEACHER and u.can_sign_in):
            return _back("wrong_account")
        if q.get("error") or not q.get("code"):
            return _back("denied")
        try:
            got = google.exchange_code(q["code"])
        except GoogleError as e:
            return _back("scope_missing" if e.code == "scope_missing" else "failed")
        now = timezone.now()
        GoogleCalendarConnection.objects.update_or_create(teacher=u, defaults={
            "google_account_email": got["email"], "encrypted_refresh_token": crypto.encrypt(got["refresh_token"]),
            "scopes": got["scopes"][:500], "status": C.ACTIVE, "connected_at": now, "revoked_at": None})
        audit("google.calendar_connected", actor=u, target=u, request=request)  # no token, no email
        # Sessions that waited for a reconnect can now be created.
        for ev in GoogleEvent.objects.filter(teacher=u, sync_status=GoogleEvent.Sync.RECONNECT, occurrence__status=SessionOccurrence.Status.PENDING):
            ev.sync_status = GoogleEvent.Sync.FAILED
            ev.save(update_fields=["sync_status", "updated_at"])
        return _back("connected")


class GoogleFakeConsent(APIView):
    """Development/CI only (GOOGLE_FAKE): stands in for Google's consent page."""

    permission_classes = [AllowAny]

    def get(self, request):
        if not settings.GOOGLE_FAKE:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        from urllib.parse import urlencode

        return HttpResponseRedirect("/api/v1/integrations/google/callback?" + urlencode({"state": request.query_params.get("state", ""), "code": "fake-code"}))


class GoogleDisconnect(APIView):
    permission_classes = [IsTeacher]

    def post(self, request):
        conn = GoogleCalendarConnection.objects.filter(teacher=request.user).first()
        if conn and conn.status != C.REVOKED:
            google.revoke(conn)
            conn.status, conn.encrypted_refresh_token, conn.revoked_at = C.REVOKED, "", timezone.now()
            conn.save(update_fields=["status", "encrypted_refresh_token", "revoked_at", "updated_at"])
            audit("google.calendar_disconnected", actor=request.user, target=request.user, request=request)
        return Response(status_out(request.user))


# ---- teacher sessions ----------------------------------------------------------------------------------------------
class SessionIn(serializers.Serializer):
    student = serializers.IntegerField(required=False, allow_null=True)
    circle = serializers.IntegerField(required=False, allow_null=True)
    topic = serializers.ChoiceField(choices=SessionOccurrence.Topic.choices)
    date = serializers.DateField()
    time = serializers.TimeField()
    minutes = serializers.IntegerField(min_value=15, max_value=180)
    title = serializers.CharField(max_length=120, required=False, allow_blank=True, default="")
    prep_note = serializers.CharField(max_length=500, required=False, allow_blank=True, default="")


def _start(teacher, d) -> datetime:
    tz = ZoneInfo(teacher.timezone or "Africa/Cairo")
    start = datetime.combine(d["date"], d["time"], tz)
    now = timezone.now()
    if start < now + timedelta(minutes=15) or start > now + timedelta(days=120):
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"time": ["اختر موعدًا بعد ربع ساعة على الأقل وخلال أربعة أشهر."]})
    return start


def session_out(occ: SessionOccurrence) -> dict:
    ev = getattr(occ, "google_event", None)
    who = ({"kind": "circle", "id": occ.circle_id, "name": occ.circle.name} if occ.circle_id
           else {"kind": "student", "id": ev.student_id, "name": ev.student.full_name} if ev and ev.student_id else None)
    return {"id": occ.pk, "status": occ.status, "topic": occ.topic, "topic_label": occ.get_topic_display() if occ.topic else "",
            "title": occ.title, "prep_note": occ.prep_note, "starts_at": occ.starts_at.isoformat(), "ends_at": occ.ends_at.isoformat(),
            "minutes": int((occ.ends_at - occ.starts_at).total_seconds() // 60), "with": who,
            "meeting_url": occ.meeting_url,  # the teacher's own session
            "google": google_out(ev, teacher_view=True)}


def google_out(ev: GoogleEvent | None, *, teacher_view: bool = False) -> dict | None:
    if ev is None:
        return None
    out = {"sync_status": ev.sync_status, "meet_ready": bool(ev.meet_url), "error": ev.last_error,
           "error_message": sync.message(ev.last_error) if ev.last_error and ev.sync_status != GoogleEvent.Sync.READY else "",
           "last_synced_at": ev.last_synced_at.isoformat() if ev.last_synced_at else None, "cancel_pending": ev.cancel_pending}
    if teacher_view:
        out["calendar_url"] = ev.html_link
    else:
        out["event_id"] = f"{ev.event_id[:9]}…{ev.event_id[-4:]}"
    return out


def _own_session(request, pk) -> SessionOccurrence:
    occ = SessionOccurrence.objects.select_related("circle").filter(pk=pk, teacher=request.user, google_event__isnull=False).first()
    if occ is None:
        raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
    return occ


class TeacherSessions(APIView):
    """POST «إنشاء الجلسة»: one session for a linked student or one of the teacher's circles, with its Google
    Calendar event and Meet. Header Idempotency-Key (or body `request_id`): a repeated submit returns the same
    session and never creates a second event. 201 when ready; 202 while Google is still finishing."""

    permission_classes = [IsTeacher]

    def post(self, request):
        key = str(request.headers.get("Idempotency-Key") or request.data.get("request_id") or "")[:64]
        if len(key) < 8:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"request_id": ["معرّف الطلب مطلوب."]})
        prior = GoogleEvent.objects.filter(teacher=request.user, creation_key=key).select_related("occurrence").first()
        if prior is not None:  # double click, timeout retry, platform retry
            if prior.sync_status not in (GoogleEvent.Sync.READY, GoogleEvent.Sync.CANCELLED):
                prior = sync.try_create(prior.pk)
            return self._answer(prior.occurrence)
        s = SessionIn(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        try:
            sync.connection_for(request.user)
        except GoogleError as e:
            raise sync.api_error(e) from None
        student = circle = None
        if bool(d.get("student")) == bool(d.get("circle")):
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"student": ["اختر طالبًا أو حلقة."]})
        if d.get("student"):
            student = User.objects.filter(pk=d["student"], role=Role.STUDENT, status=AccountStatus.ACTIVE,
                                          pk__in=assigned_student_ids(request.user)).first()
            if student is None:
                raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"student": ["الطالب غير مرتبط بك أو غير نشط."]})
        else:
            circle = Circle.objects.filter(pk=d["circle"], teacher=request.user, state=Circle.State.PUBLISHED).first()
            if circle is None:
                raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"circle": ["الحلقة غير موجودة أو غير منشورة."]})
        start = _start(request.user, d)
        try:
            with transaction.atomic():
                occ = SessionOccurrence.objects.create(
                    teacher=request.user, starts_at=start, ends_at=start + timedelta(minutes=d["minutes"]),
                    kind=SessionOccurrence.Kind.GROUP if circle else SessionOccurrence.Kind.INDIVIDUAL,
                    capacity=circle.capacity if circle else 1, circle=circle, status=SessionOccurrence.Status.PENDING,
                    topic=d["topic"], title=d["title"].strip(), prep_note=d["prep_note"].strip())
                ev = GoogleEvent.objects.create(occurrence=occ, teacher=request.user, student=student, creation_key=key)
        except IntegrityError as e:
            if "google_event_once_per_request" in str(e):
                return self._answer(GoogleEvent.objects.get(teacher=request.user, creation_key=key).occurrence)
            raise ApiError("overlap", "يتعارض هذا الموعد مع جلسة أخرى لديك.", 409) from None
        audit("session.created", actor=request.user, target=occ, request=request, topic=d["topic"],
              circle=circle.pk if circle else None, student=student.pk if student else None)
        sync.try_create(ev.pk)
        occ.refresh_from_db()
        return self._answer(occ)

    @staticmethod
    def _answer(occ):
        occ = SessionOccurrence.objects.select_related("circle", "google_event", "google_event__student").get(pk=occ.pk)
        ev = occ.google_event
        out = session_out(occ)
        if ev.sync_status == GoogleEvent.Sync.READY:
            return Response(out, status=201)
        if ev.sync_status == GoogleEvent.Sync.PENDING:
            return Response(out, status=202)  # Google is still preparing the Meet; nobody has been notified yet
        raise ApiError(f"google_{ev.last_error or 'failed'}", sync.message(ev.last_error), 409 if ev.sync_status == GoogleEvent.Sync.RECONNECT else 502,
                       {"session": [str(occ.pk)]})


class TeacherSessionDetail(APIView):
    """GET one Google-backed session; PATCH {date, time, minutes, title} «تعديل الموعد»: the same Google event moves
    (Google first, inside the transaction; if Google refuses nothing changes in HALQA)."""

    permission_classes = [IsTeacher]

    def get(self, request, pk):
        return Response(session_out(_own_session(request, pk)))

    def patch(self, request, pk):
        _own_session(request, pk)
        d = request.data
        with transaction.atomic():
            occ = SessionOccurrence.objects.select_for_update(of=("self",)).select_related("circle").get(pk=pk)
            if occ.status == SessionOccurrence.Status.CANCELLED or occ.starts_at <= timezone.now():
                raise ApiError("closed", "انتهت هذه الجلسة أو أُلغيت.", 409)
            old = (occ.starts_at, occ.ends_at)
            minutes = int(d.get("minutes") or (occ.ends_at - occ.starts_at).total_seconds() // 60)
            if not 15 <= minutes <= 180:
                raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"minutes": ["المدة بين 15 و180 دقيقة."]})
            if d.get("date") or d.get("time"):
                tz = ZoneInfo(request.user.timezone or "Africa/Cairo")
                local = occ.starts_at.astimezone(tz)
                try:
                    nd = datetime.fromisoformat(str(d.get("date"))).date() if d.get("date") else local.date()
                    nt = datetime.strptime(str(d.get("time"))[:5], "%H:%M").time() if d.get("time") else local.time()
                except ValueError:
                    raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"time": ["تاريخ أو وقت غير صالح."]}) from None
                occ.starts_at = _start(request.user, {"date": nd, "time": nt})
            occ.ends_at = occ.starts_at + timedelta(minutes=minutes)
            if "title" in d:
                occ.title = str(d.get("title") or "").strip()[:120]
            try:
                with transaction.atomic():
                    occ.save(update_fields=["starts_at", "ends_at", "title", "updated_at"])
            except IntegrityError:
                raise ApiError("overlap", "يتعارض هذا الموعد مع جلسة أخرى لديك.", 409) from None
            sync.patch_times(occ)  # raises → everything above rolls back
            moved = old != (occ.starts_at, occ.ends_at)
            audit("session.google_rescheduled" if moved else "session.updated", actor=request.user, target=occ, request=request,
                  old_start=old[0].isoformat() if moved else None, new_start=occ.starts_at.isoformat() if moved else None)
            if moved and occ.status == SessionOccurrence.Status.SCHEDULED:
                from apps.notifications.services import after_commit

                for b in occ.bookings.filter(status="confirmed").select_related("student"):
                    local = timezone.localtime(occ.starts_at, ZoneInfo(b.student.timezone or "Africa/Cairo"))
                    after_commit(b.student, "booking_rescheduled", "تغيّر موعد جلستك", sync._when_text(local), link="/sessions",
                                 dedupe=f"gcal-move:{occ.pk}:{b.student_id}:{occ.starts_at.timestamp():.0f}", data={"booking": b.pk})
        return Response(session_out(SessionOccurrence.objects.select_related("circle", "google_event").get(pk=pk)))


class TeacherSessionCancel(APIView):
    """POST {reason}: «إلغاء الجلسة» — bookings cancelled and students notified (HALQA history kept), then the Google
    event is deleted with updates to attendees (retried later if Google is unreachable)."""

    permission_classes = [IsTeacher]

    def post(self, request, pk):
        occ = _own_session(request, pk)
        reason = str(request.data.get("reason") or "ألغى المعلم الجلسة").strip()[:200]
        if occ.status == SessionOccurrence.Status.PENDING:
            with transaction.atomic():
                SessionOccurrence.objects.filter(pk=pk).update(status=SessionOccurrence.Status.CANCELLED, updated_at=timezone.now())
            sync.cancel_event(pk)
        else:
            from apps.scheduling.services import cancel_occurrence

            cancel_occurrence(occurrence_id=pk, by=request.user, reason=reason)  # its on_commit hook tells Google
        audit("session.cancelled", actor=request.user, target=occ, request=request)
        return Response(session_out(SessionOccurrence.objects.select_related("circle", "google_event").get(pk=pk)))


class TeacherSessionRetry(APIView):
    """POST «أعد المحاولة»: finish a session whose Google event or Meet could not be created yet."""

    permission_classes = [IsTeacher]

    def post(self, request, pk):
        occ = _own_session(request, pk)
        sync.try_create(occ.google_event.pk)
        return TeacherSessions._answer(occ)


class AdminSessionGoogle(APIView):
    """GET (sessions.view): the Google state of a session (no tokens, event id shortened). POST (sessions.manage)
    «إعادة المزامنة»: finish creation, refresh the event, or create a Meet only if the event has none."""

    permission_classes = [IsAdminRole]
    admin_perm = {"read": "sessions.view", "write": "sessions.manage"}

    def get(self, request, pk):
        ev = GoogleEvent.objects.filter(occurrence_id=pk).first()
        if ev is None:
            raise ApiError("not_found", "لا يوجد حدث Google لهذه الجلسة.", 404)
        return Response({**google_out(ev), "calendar_url": ev.html_link})

    def post(self, request, pk):
        ev = GoogleEvent.objects.select_related("occurrence", "teacher").filter(occurrence_id=pk).first()
        if ev is None:
            raise ApiError("not_found", "لا يوجد حدث Google لهذه الجلسة.", 404)
        try:
            ev = sync.resync(ev)
        except GoogleError as e:
            raise sync.api_error(e) from None
        audit("session.google_resynced", actor=request.user, target=ev.occurrence, request=request, result=ev.sync_status)
        return Response({**google_out(ev), "calendar_url": ev.html_link})
