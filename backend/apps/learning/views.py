from rest_framework import generics
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import Role
from apps.accounts.permissions import IsLearningUser, IsStudent, assigned_student_ids, scope_by_student
from apps.core.audit import audit
from apps.core.exceptions import ApiError

from . import services
from .models import Assignment, AssignmentStatus
from .serializers import AssignmentSerializer


class AssignmentList(generics.ListCreateAPIView):
    """Students: own work. Teachers: work they assigned / for assigned students. Parents: linked children."""

    permission_classes = [IsLearningUser]
    serializer_class = AssignmentSerializer

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
