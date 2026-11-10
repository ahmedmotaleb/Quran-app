"""Preferred-teacher requests «اختر معلمك» and the reminder for students without a teacher (owner request, 4 Nov 2026).

Student: picks an approved teacher (or suggests one by name) → a PENDING request; one pending request at a time; a
student who already has a teacher cannot request. The request never assigns anyone.
Admin («طلبات اختيار المعلم», `teachers.assign`): approve → APPROVED; «غير متاح» → UNAVAILABLE (optionally suggesting
another teacher); assign → ASSIGNED, through the normal TeacherAssignment. The student is notified on every change.
Any assignment (here, the student record or a bulk action) closes the open request and stops the reminders
(`on_assigned`, a TeacherAssignment signal).
Reminder (`teacher_reminders`, hourly job): a student with no teacher gets one in-app notice every
AppSettings.teacher_reminder_hours (default 48; 0 = off) — never while one is still unread; «طلبك قيد المراجعة»
instead of «اختر معلمك» when a request is pending.
"""
from __future__ import annotations

from datetime import timedelta

from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework import serializers
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.audit import audit
from apps.core.exceptions import ApiError

from .models import AccountStatus, Role, TeacherAssignment, TeacherRequest, User
from .permissions import IsAdminRole, IsStudent

S = TeacherRequest.Status
OPEN = (S.PENDING, S.APPROVED, S.UNAVAILABLE)


def _approved_teacher(pk) -> User | None:
    return User.objects.filter(pk=pk, role=Role.TEACHER, status=AccountStatus.ACTIVE, is_active=True,
                               teacher_profile__approved_at__isnull=False).first()


def _name(u) -> str | None:
    return u.display_name if u else None


def out(r: TeacherRequest, admin: bool = False) -> dict:
    d = {"id": r.id, "status": r.status, "status_label": S(r.status).label, "created_at": r.created_at.isoformat(),
         "teacher": {"id": r.teacher_id, "name": _name(r.teacher)} if r.teacher_id else None, "suggested_name": r.suggested_name,
         "note": r.note, "alternative": {"id": r.alternative_id, "name": _name(r.alternative)} if r.alternative_id else None,
         "assigned_teacher": {"id": r.assigned_teacher_id, "name": _name(r.assigned_teacher)} if r.assigned_teacher_id else None,
         "decided_at": r.decided_at.isoformat() if r.decided_at else None}
    if admin:
        from apps.notifications.models import Notification

        d["student"] = {"id": r.student_id, "name": r.student.full_name}
        d["admin_note"] = r.admin_note
        d["history"] = [{"at": n.created_at.isoformat(), "title": n.title, "body": n.body, "read": bool(n.read_at)}
                        for n in Notification.objects.filter(recipient_id=r.student_id, dedupe_key__startswith=f"teacher_request:{r.pk}:")
                        .order_by("created_at")]
    return d


def _notify(r: TeacherRequest, title: str, body: str) -> None:
    from apps.notifications.services import after_commit

    after_commit(r.student, f"teacher_request_{r.status}", title, body, link="/circles",
                 dedupe=f"teacher_request:{r.pk}:{r.status}", data={"teacher_request": r.pk})


def has_teacher(student) -> bool:
    return TeacherAssignment.objects.filter(student=student, active=True).exists()


# ---- Student -----------------------------------------------------------------------------------------------------
class RequestIn(serializers.Serializer):
    teacher = serializers.IntegerField(required=False, allow_null=True)
    suggested_name = serializers.CharField(required=False, allow_blank=True, max_length=120, default="")
    note = serializers.CharField(required=False, allow_blank=True, max_length=300, default="")

    def validate(self, d):
        name = d.get("suggested_name", "").strip()
        if bool(d.get("teacher")) == bool(name):
            raise serializers.ValidationError({"teacher": ["اختر معلمًا من القائمة أو اكتب اسم المعلم الذي تقترحه."]})
        if name and len(name) < 3:
            raise serializers.ValidationError({"suggested_name": ["اكتب اسم المعلم كاملًا."]})
        d["suggested_name"] = name
        return d


class MyTeacherRequest(APIView):
    """GET: whether the student has a teacher and their latest open request. POST: request a teacher / suggest one."""

    permission_classes = [IsStudent]

    def get(self, request):
        u = request.user
        r = TeacherRequest.objects.filter(student=u, status__in=OPEN).select_related("teacher", "alternative").first()
        return Response({"has_teacher": has_teacher(u), "request": out(r) if r else None})

    def post(self, request):
        u = request.user
        if has_teacher(u):
            raise ApiError("has_teacher", "لديك معلم بالفعل. تواصل مع الإدارة إن أردت تغييره.", 409)
        s = RequestIn(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        teacher = None
        if d.get("teacher"):
            teacher = _approved_teacher(d["teacher"])
            if teacher is None:
                raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"teacher": ["هذا المعلم غير متاح للاختيار."]})
        if TeacherRequest.objects.filter(student=u, status=S.PENDING).exists():
            raise ApiError("duplicate_request", "لديك طلب قيد المراجعة بالفعل.", 409)
        try:
            with transaction.atomic():
                # A new request replaces an older decided-but-open one (approved / unavailable).
                r = TeacherRequest.objects.create(student=u, teacher=teacher, suggested_name=d["suggested_name"], note=d["note"].strip())
        except IntegrityError:
            raise ApiError("duplicate_request", "لديك طلب قيد المراجعة بالفعل.", 409) from None
        audit("student.teacher_requested", actor=u, target=r, request=request, teacher=teacher.pk if teacher else None,
              suggested=bool(d["suggested_name"]))
        notify_admins_new(r)
        return Response(out(r), status=201)


def notify_admins_new(r: TeacherRequest) -> None:
    """A new «اختر معلمك» request: the administrators who may assign teachers (only they see the student's name)."""
    from apps.accounts.admin_access import admins_with
    from apps.notifications.services import after_commit

    who = r.teacher.display_name if r.teacher_id else f"اقتراح: {r.suggested_name}"
    for a in admins_with("teachers.assign"):
        after_commit(a, "admin_teacher_request", "طلب اختيار معلم جديد", f"{r.student.full_name} · {who}", link="/admin",
                     dedupe=f"teacher_request:{r.pk}:admin:{a.pk}", data={"teacher_request": r.pk, "admin_section": "teacherRequests"})


# ---- Admin -------------------------------------------------------------------------------------------------------
class AdminTeacherRequests(APIView):
    admin_perm = {"read": "teachers.view", "write": "teachers.assign"}
    permission_classes = [IsAdminRole]

    def get(self, request):
        qs = TeacherRequest.objects.select_related("student", "teacher", "alternative", "assigned_teacher")
        st = request.query_params.get("status")
        if st in S.values:
            qs = qs.filter(status=st)
        elif st == "open":
            qs = qs.filter(status__in=OPEN)
        pg = PageNumberPagination()
        pg.page_size = 50
        page = pg.paginate_queryset(qs, request, view=self)
        return pg.get_paginated_response([out(r, admin=True) for r in page])


class DecideIn(serializers.Serializer):
    action = serializers.ChoiceField(choices=["approve", "unavailable", "assign"])
    teacher = serializers.IntegerField(required=False, allow_null=True)  # assign: who; unavailable: an alternative
    note = serializers.CharField(required=False, allow_blank=True, max_length=300, default="")


class AdminTeacherRequestDecide(APIView):
    admin_perm = "teachers.assign"
    permission_classes = [IsAdminRole]

    def post(self, request, pk):
        s = DecideIn(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        with transaction.atomic():
            r = TeacherRequest.objects.select_for_update().filter(pk=pk).select_related("student").first()
            if r is None:
                raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
            if r.status == S.ASSIGNED:
                raise ApiError("already_assigned", "عُيّن المعلم لهذا الطلب بالفعل.", 409)
            other = _approved_teacher(d["teacher"]) if d.get("teacher") else None
            if d.get("teacher") and other is None:
                raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"teacher": ["اختر معلمًا معتمدًا ونشطًا."]})
            r.admin_note, r.decided_by, r.decided_at = d["note"].strip(), request.user, timezone.now()
            if d["action"] == "approve":
                if r.status != S.PENDING:
                    raise ApiError("invalid_state", "يمكن الموافقة على الطلبات قيد المراجعة فقط.", 409)
                r.status = S.APPROVED
                r.save()
                _notify(r, "تمت الموافقة على طلب اختيار المعلم", "ستعيّن الإدارة معلمك قريبًا.")
            elif d["action"] == "unavailable":
                r.status, r.alternative = S.UNAVAILABLE, other
                r.save()
                _notify(r, "المعلم المطلوب غير متاح", f"تقترح الإدارة: {other.display_name}. يمكنك طلبه من «اختر معلمك»." if other
                        else "اختر معلمًا آخر من «اختر معلمك».")
            else:
                teacher = other or (_approved_teacher(r.teacher_id) if r.teacher_id else None)
                if teacher is None:
                    raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"teacher": ["اختر المعلم الذي سيُعيَّن للطالب."]})
                if r.student.status != AccountStatus.ACTIVE:
                    raise ApiError("student_inactive", "حساب الطالب غير نشط.", 409)
                r.status, r.assigned_teacher = S.ASSIGNED, teacher
                r.save()
                _notify(r, "تم تعيين معلمك", f"معلمك: {teacher.display_name}.")
                if not TeacherAssignment.objects.filter(teacher=teacher, student=r.student, active=True).exists():
                    a = TeacherAssignment.objects.create(teacher=teacher, student=r.student, created_by=request.user)
                    audit("admin.teacher_assigned", actor=request.user, target=a, request=request, via="teacher_request")
                on_assigned(r.student, teacher, tell=False)  # other open requests closed, reminders cleared (the new link tells the teacher)
            audit("admin.teacher_request_decided", actor=request.user, target=r, request=request, decision=d["action"],
                  teacher=d.get("teacher"))
        r.refresh_from_db()
        return Response(out(r, admin=True))


def on_assigned(student, teacher, assignment_id: int | None = None, tell: bool = True) -> None:
    """A teacher was assigned (any path: «اختر معلمك» review, the student record, a bulk action). Closes the open
    request as ASSIGNED, clears the «اختر معلمك» reminders, and tells both people: the student «تم تعيين معلمك» (once —
    through the request when there was one) and the teacher «طالب جديد»."""
    from apps.notifications.models import Notification
    from apps.notifications.services import after_commit

    told = False
    for r in TeacherRequest.objects.filter(student=student, status__in=OPEN):
        r.status, r.assigned_teacher = S.ASSIGNED, teacher
        r.decided_at = r.decided_at or timezone.now()
        r.save(update_fields=["status", "assigned_teacher", "decided_at", "updated_at"])
        _notify(r, "تم تعيين معلمك", f"معلمك: {teacher.display_name}.")
        told = True
    # Assigned through the review just now (AdminTeacherRequestDecide already told the student).
    told = told or TeacherRequest.objects.filter(student=student, status=S.ASSIGNED, assigned_teacher=teacher,
                                                 decided_at__gte=timezone.now() - timedelta(minutes=5)).exists()
    if not tell:
        Notification.objects.filter(recipient=student, kind__startswith="teacher_pick", read_at__isnull=True).update(read_at=timezone.now())
        return
    key = f"assignment:{assignment_id or f'{student.pk}-{teacher.pk}'}"
    if not told:
        after_commit(student, "teacher_assigned", "تم تعيين معلمك", f"معلمك: {teacher.display_name}.", link="/circles",
                     dedupe=f"{key}:student", data={"screen": "home"})
    after_commit(teacher, "student_assigned", "طالب جديد", f"انضم {student.full_name} إلى طلابك.", link="/teacher/students",
                 dedupe=f"{key}:teacher", data={"student": student.pk, "screen": "students"})
    Notification.objects.filter(recipient=student, kind__startswith="teacher_pick", read_at__isnull=True).update(read_at=timezone.now())


# ---- Reminder (hourly job) ---------------------------------------------------------------------------------------
def send_reminders(now=None) -> dict:
    from apps.core.models import AppSettings
    from apps.notifications.models import Notification
    from apps.notifications.services import notify

    hours = AppSettings.load().teacher_reminder_hours
    sent = {"pick": 0, "pending": 0}
    if not hours:
        return sent
    now = now or timezone.now()
    students = (User.objects.filter(role=Role.STUDENT, status=AccountStatus.ACTIVE, is_active=True)
                .exclude(teacher_assignments__active=True))
    for u in students:
        mine = Notification.objects.filter(recipient=u, kind__startswith="teacher_pick")
        if mine.filter(read_at__isnull=True).exists() or mine.filter(created_at__gt=now - timedelta(hours=hours)).exists():
            continue  # one unread at a time, and at most one per period
        pending = TeacherRequest.objects.filter(student=u, status__in=(S.PENDING, S.APPROVED)).exists()
        kind, title, body = (("teacher_pick_pending", "طلبك قيد المراجعة", "تراجع الإدارة طلب اختيار معلمك، وسيصلك إشعار عند تعيينه.")
                             if pending else ("teacher_pick", "اختر معلمك", "اختر معلمًا من «اختر معلمك» لتبدأ الحفظ والمراجعة معه."))
        if notify(u, kind, title, body, link="/home", dedupe=f"teacher_pick:{int(now.timestamp()) // (hours * 3600)}", data={"screen": "home"}):
            sent["pending" if pending else "pick"] += 1
    return sent
