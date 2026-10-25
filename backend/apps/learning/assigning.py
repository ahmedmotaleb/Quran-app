"""Creating tasks (PROMPT 43): from the teacher's student file, for a whole circle, and by academic admins.

Every path goes through `create_assignment`, so validation (Hafs ranges), audit and the student's notification are
identical. A task always has a responsible teacher who is linked to the student, because only linked teachers can
open the student's recordings and review them.
"""
from __future__ import annotations

from django.db import transaction
from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import AccountStatus, Role, TeacherAssignment, User
from apps.accounts.permissions import IsAdminRole, IsTeacher
from apps.core.audit import audit
from apps.core.exceptions import ApiError

from .models import Assignment
from .serializers import AssignmentSerializer


def create_assignment(teacher: User, student: User, data: dict, *, actor: User, request=None, **audit_data) -> Assignment:
    a = Assignment.objects.create(teacher=teacher, student=student, **data)
    audit("assignment.created", actor=actor, target=a, request=request, **audit_data)
    from apps.notifications.services import after_commit

    after_commit(student, "assignment_new", "واجب جديد من معلمك", f"{a.title} · {teacher.display_name}", link=f"/tasks/{a.pk}",
                 dedupe=f"assignment:{a.pk}:new", data={"assignment": a.pk})
    return a


class TaskFields(AssignmentSerializer):
    """The task itself, without the student (a circle) — same validation as a single task."""

    class Meta(AssignmentSerializer.Meta):
        fields = ["kind", "title", "surah", "ayah_from", "ayah_to", "instructions", "due_at", "requires_recording"]


def _linked(teacher_id: int, student_id: int) -> bool:
    return TeacherAssignment.objects.filter(teacher_id=teacher_id, student_id=student_id, active=True).exists()


class TeacherCircles(APIView):
    """The teacher's own circles, with how many active members a circle task would reach."""

    permission_classes = [IsTeacher]

    def get(self, request):
        from apps.scheduling.models import Circle, CircleMember

        out = []
        for c in Circle.objects.filter(teacher=request.user).exclude(state="off").order_by("name"):
            members = CircleMember.objects.filter(circle=c, active=True).select_related("student")
            reach = sum(1 for m in members if m.student.status == AccountStatus.ACTIVE and _linked(request.user.pk, m.student_id))
            out.append({"id": c.pk, "name": c.name, "state": c.state, "members": members.count(), "reachable": reach})
        return Response({"results": out})


class CircleAssignments(APIView):
    """POST: «إرسال مهمة لكل الحلقة» — one task per active member, in one transaction, with a result per member.
    Skipped (never created): ended memberships are not members at all; suspended/archived accounts; members not
    linked to this teacher (their recordings could not be reviewed)."""

    permission_classes = [IsTeacher]

    def post(self, request, pk):
        from apps.scheduling.models import Circle, CircleMember

        c = Circle.objects.filter(pk=pk, teacher=request.user).first()
        if c is None:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        s = TaskFields(data=request.data)
        s.is_valid(raise_exception=True)
        results, created = [], 0
        with transaction.atomic():
            for m in CircleMember.objects.filter(circle=c, active=True).select_related("student").order_by("student__full_name"):
                st = m.student
                row = {"student": st.pk, "name": st.full_name}
                if st.status != AccountStatus.ACTIVE:
                    results.append({**row, "outcome": "skipped", "message": "الحساب غير نشط."})
                elif not _linked(request.user.pk, st.pk):
                    results.append({**row, "outcome": "skipped", "message": "الطالب غير مرتبط بك؛ اطلب ربطه من الإدارة."})
                else:
                    a = create_assignment(request.user, st, dict(s.validated_data), actor=request.user, request=request, circle=c.pk)
                    created += 1
                    results.append({**row, "outcome": "created", "assignment": a.pk})
            audit("assignment.circle_batch", actor=request.user, target=c, request=request, created=created,
                  skipped=len(results) - created)
        return Response({"created": created, "skipped": len(results) - created, "results": results}, status=201)


class AdminAssignmentIn(AssignmentSerializer):
    class Meta(AssignmentSerializer.Meta):
        fields = ["student", "teacher", "kind", "title", "surah", "ayah_from", "ayah_to", "instructions", "due_at", "requires_recording"]
        read_only_fields: list = []
        extra_kwargs = {"teacher": {"required": False, "allow_null": True}}


class AdminAssignmentCreate(APIView):
    """POST: a task for a student by an admin with `assignments.manage` (academic). The responsible teacher must be one
    of the student's linked teachers (the only one when there is exactly one)."""

    permission_classes = [IsAdminRole]
    admin_perm = "assignments.manage"

    def post(self, request):
        s = AdminAssignmentIn(data=request.data)
        s.is_valid(raise_exception=True)
        d = dict(s.validated_data)
        student, teacher = d.pop("student"), d.pop("teacher", None)
        if student.role != Role.STUDENT or student.status != AccountStatus.ACTIVE:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"student": ["اختر طالبًا نشطًا."]})
        linked = list(User.objects.filter(pk__in=TeacherAssignment.objects.filter(student=student, active=True).values("teacher_id")))
        if not linked:
            raise ApiError("no_teacher", "الطالب غير مرتبط بمعلم. اربطه بمعلم أولًا ليراجع تسليمه.", 409)
        if teacher is None:
            if len(linked) > 1:
                raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"teacher": ["اختر المعلم المسؤول عن المهمة."]})
            teacher = linked[0]
        elif teacher.pk not in {t.pk for t in linked}:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"teacher": ["اختر معلمًا مرتبطًا بهذا الطالب."]})
        with transaction.atomic():
            a = create_assignment(teacher, student, d, actor=request.user, request=request, by_admin=True)
        return Response(AssignmentSerializer(a).data, status=201)
