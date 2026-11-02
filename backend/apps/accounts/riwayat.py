"""Teachers' Qira'at qualifications (القراءات والروايات).

- The teacher chooses one or more Riwayat (at least one). A Riwayah they add waits for the admin (`verified_at`
  empty); removing one applies at once (saying they no longer teach it carries no risk).
- An admin sets the confirmed list (and approving a teacher confirms what they chose). Learners only see confirmed
  Riwayat, and can filter teachers by one.
- Only canonical codes (qiraat.CANON) are accepted; every change is audited with the codes before and after.
"""
from __future__ import annotations

from django.db import transaction
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.audit import audit
from apps.core.exceptions import ApiError

from .models import Qiraah, Riwayah, Role, TeacherRiwayah, User
from .permissions import IsAdminRole, IsTeacher
from .qiraat import parse_selection


def catalog() -> list[dict]:
    return [{"code": q.code, "name": q.name_ar, "order": q.order,
             "riwayat": [{"code": r.code, "name": r.name_ar, "narrator": r.narrator_ar, "order": r.order} for r in q.riwayat.all()]}
            for q in Qiraah.objects.prefetch_related("riwayat")]


def row_out(t: TeacherRiwayah) -> dict:
    r = t.riwayah
    return {"code": r.code, "name": r.name_ar, "qiraah": r.qiraah.code, "qiraah_name": r.qiraah.name_ar, "verified": bool(t.verified_at)}


def rows_for(teacher: User, verified_only: bool = False) -> list[dict]:
    qs = TeacherRiwayah.objects.filter(teacher=teacher).select_related("riwayah__qiraah").order_by("riwayah__qiraah__order", "riwayah__order")
    if verified_only:
        qs = qs.filter(verified_at__isnull=False)
    return [row_out(t) for t in qs]


def _parse(data, *, allow_empty: bool) -> list[str]:
    try:
        codes = parse_selection(data.get("riwayat") if isinstance(data, dict) else None)
    except ValueError as e:
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"riwayat": [str(e)]}) from None
    if not codes and not allow_empty:
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"riwayat": ["اختر رواية واحدة على الأقل."]})
    return codes


def verify_pending(teacher: User, actor) -> list[str]:
    """Approving a teacher confirms the Riwayat they chose (shown to the admin before approving)."""
    rows = TeacherRiwayah.objects.filter(teacher=teacher, verified_at__isnull=True).select_related("riwayah")
    codes = [r.riwayah.code for r in rows]
    rows.update(verified_at=timezone.now(), verified_by=actor)
    return codes


class QiraatCatalog(APIView):
    """GET: the ten Qira'at with their two Riwayat each (stable codes + Arabic names)."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(catalog())


class MyRiwayat(APIView):
    """The signed-in teacher's qualifications. PUT {"riwayat": [codes]} (at least one)."""

    permission_classes = [IsTeacher]

    def get(self, request):
        return Response({"riwayat": rows_for(request.user)})

    def put(self, request):
        codes = _parse(request.data, allow_empty=False)
        t = request.user
        with transaction.atomic():
            have = {r.riwayah.code: r for r in TeacherRiwayah.objects.select_for_update().filter(teacher=t).select_related("riwayah")}
            removed = sorted(set(have) - set(codes))
            added = [c for c in codes if c not in have]
            TeacherRiwayah.objects.filter(teacher=t, riwayah__code__in=removed).delete()
            by_code = {r.code: r for r in Riwayah.objects.filter(code__in=added)}
            TeacherRiwayah.objects.bulk_create([TeacherRiwayah(teacher=t, riwayah=by_code[c]) for c in added])
            if added or removed:
                audit("teacher.riwayat_updated", actor=t, target=t, request=request, added=added, removed=removed)
        return Response({"riwayat": rows_for(t)})


class AdminTeacherRiwayat(APIView):
    """Admin: view, edit and confirm a teacher's qualifications. PUT {"riwayat": [codes]} sets the confirmed list."""

    # Reading needs what reading a teacher's record needs; confirming/editing needs teacher approval.
    admin_perm = {"read": "teachers.view", "write": "teachers.approve"}
    permission_classes = [IsAdminRole]

    def _teacher(self, pk) -> User:
        t = User.objects.filter(pk=pk, role=Role.TEACHER).first()
        if t is None:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        return t

    def get(self, request, pk):
        return Response({"riwayat": rows_for(self._teacher(pk))})

    def put(self, request, pk):
        t = self._teacher(pk)
        codes = _parse(request.data, allow_empty=True)
        with transaction.atomic():
            before = [x["code"] + ("" if x["verified"] else "?") for x in rows_for(t)]
            TeacherRiwayah.objects.filter(teacher=t).exclude(riwayah__code__in=codes).delete()
            now = timezone.now()
            for r in Riwayah.objects.filter(code__in=codes):
                TeacherRiwayah.objects.update_or_create(teacher=t, riwayah=r, defaults={"verified_at": now, "verified_by": request.user})
            audit("admin.teacher_riwayat", actor=request.user, target=t, request=request, before=before, after=codes)
        return Response({"riwayat": rows_for(t)})
