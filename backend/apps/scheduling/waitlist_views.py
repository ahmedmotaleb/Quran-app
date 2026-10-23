"""Waiting list and make-up endpoints (PROMPT 44). Rules live in waitlist.py and makeup.py."""
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.permissions import IsAdminRole, IsStudent, IsTeacher
from apps.core.exceptions import ApiError

from . import makeup, waitlist
from .models import MakeupCredit, WaitlistEntry
from .serializers import BookingSerializer


class MyWaitlist(APIView):
    """GET: the student's open and recent entries (lapsed offers are expired first). POST {occurrence}: join."""

    permission_classes = [IsStudent]
    throttle_scope = "booking"

    def get(self, request):
        W = WaitlistEntry.Status
        for occ_id in set(WaitlistEntry.objects.filter(student=request.user, status__in=[W.WAITING, W.OFFERED]).values_list("occurrence_id", flat=True)):
            waitlist.tick(occ_id)
        qs = (WaitlistEntry.objects.filter(student=request.user).select_related("occurrence__teacher", "occurrence__circle")
              .order_by("-joined_at")[:30])
        return Response({"results": [waitlist.entry_out(e) for e in qs]})

    def post(self, request):
        try:
            occ = int(request.data.get("occurrence"))
        except (TypeError, ValueError):
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"occurrence": ["موعد غير صالح."]}) from None
        e = waitlist.join(request.user, occ, request)
        e = WaitlistEntry.objects.select_related("occurrence__teacher", "occurrence__circle").get(pk=e.pk)
        return Response(waitlist.entry_out(e), status=201)


class WaitlistAccept(APIView):
    permission_classes = [IsStudent]
    throttle_scope = "booking"

    def post(self, request, pk):
        b = waitlist.accept(request.user, pk, request.headers.get("Idempotency-Key", ""), request)
        return Response(BookingSerializer(b, context={"request": request}).data, status=201)


class WaitlistLeave(APIView):
    permission_classes = [IsStudent]

    def post(self, request, pk):
        e = waitlist.leave(request.user, pk, request)
        return Response({"id": e.pk, "status": e.status})


class MyMakeup(APIView):
    """The student's make-up credits (available ones first)."""

    permission_classes = [IsStudent]

    def get(self, request):
        qs = MakeupCredit.objects.filter(student=request.user).select_related("teacher", "source_booking__occurrence")[:30]
        rows = sorted((makeup.credit_out(c) for c in qs), key=lambda r: (r["status"] != "available", r["expires_at"]))
        return Response({"results": rows})


class GrantMakeup(APIView):
    """POST: «منح جلسة تعويضية» for an approved excuse — the session's teacher (when the settings allow teachers)."""

    permission_classes = [IsTeacher]

    def post(self, request, pk):
        c = makeup.grant(pk, request.user, request)
        return Response(makeup.credit_out(c), status=201)


class AdminGrantMakeup(GrantMakeup):
    permission_classes = [IsAdminRole]
    admin_perm = "excuses.review"
