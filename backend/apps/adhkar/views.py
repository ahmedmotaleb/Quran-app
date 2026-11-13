"""APIs for «الأذكار والأدعية» (every signed-in role) and «إدارة مكتبة الأذكار» (administrators).

Readers only ever see approved + enabled entries. Administrators: `adhkar.view` lists everything, `adhkar.manage` adds,
edits, enables/disables, proposes the Quranic references and sends a test to their own devices; `adhkar.approve`
approves or rejects. Quranic text always comes from the verified Quran text (never from the request).
"""
from __future__ import annotations

from datetime import timedelta

from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import serializers
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.permissions import IsAdminRole
from apps.core.audit import audit
from apps.core.exceptions import ApiError

from . import seed, services
from .models import Delivery, Dhikr, Favorite, Preferences

CATS = [{"key": k, "label": v} for k, v in Dhikr.Category.choices]


def _norm(s: str) -> str:
    import re

    return re.sub(r"[ً-ْٰۖ-ۭـ]", "", s or "").replace("ٱ", "ا").replace("أ", "ا").replace("إ", "ا").replace("آ", "ا")


def out(d: Dhikr, fav: set[int] | None = None, admin: bool = False) -> dict:
    o = {"id": d.pk, "category": d.category, "category_label": d.get_category_display(), "text": d.text,
         "source_type": d.source_type, "source": services.source_label(d), "repetition": d.repetition,
         "time_of_day": d.time_of_day, "time_label": d.get_time_of_day_display(),
         "surah": d.surah, "ayah_from": d.ayah_from, "ayah_to": d.ayah_to,
         "hadith_collection": d.hadith_collection, "hadith_number": d.hadith_number, "grading": d.grading,
         "grading_label": d.get_grading_display() if d.grading else "", "graded_by": d.graded_by, "reference_url": d.reference_url}
    if fav is not None:
        o["favorite"] = d.pk in fav
    if admin:
        o.update({"status": d.status, "status_label": d.get_status_display(), "enabled": d.enabled, "origin": d.origin,
                  "created_by": d.created_by.full_name if d.created_by_id else None,
                  "reviewed_by": d.reviewed_by.full_name if d.reviewed_by_id else None,
                  "reviewed_at": d.reviewed_at.isoformat() if d.reviewed_at else None, "review_note": d.review_note,
                  "created_at": d.created_at.isoformat()})
    return o


def _filter(qs, request):
    c = request.query_params.get("category")
    if c in Dhikr.Category.values:
        qs = qs.filter(category=c)
    q = (request.query_params.get("q") or "").strip()
    if q:
        ids = [d.pk for d in qs if _norm(q) in _norm(d.text) or q in services.source_label(d)]
        qs = qs.filter(pk__in=ids)
    return qs


# ---- readers (every signed-in role) -------------------------------------------------------------------------------
class AdhkarList(APIView):
    def get(self, request):
        qs = Dhikr.objects.filter(status=Dhikr.Status.APPROVED, enabled=True).select_related("quran_source")
        if request.query_params.get("favorites") == "1":
            qs = qs.filter(favorites__user=request.user)
        qs = _filter(qs, request)
        fav = set(Favorite.objects.filter(user=request.user).values_list("dhikr_id", flat=True))
        counts = dict(Dhikr.objects.filter(status=Dhikr.Status.APPROVED, enabled=True).values_list("category").annotate(n=Count("id")))
        return Response({"categories": [{**c, "count": counts.get(c["key"], 0)} for c in CATS],
                         "results": [out(d, fav) for d in qs[:500]]})


class AdhkarDetail(APIView):
    def get(self, request, pk):
        d = Dhikr.objects.filter(pk=pk, status=Dhikr.Status.APPROVED, enabled=True).first()
        if d is None:
            raise ApiError("not_found", "هذا الذكر غير متاح.", 404)
        fav = set(Favorite.objects.filter(user=request.user, dhikr=d).values_list("dhikr_id", flat=True))
        return Response(out(d, fav))


class AdhkarFavorite(APIView):
    def post(self, request, pk):
        d = Dhikr.objects.filter(pk=pk, status=Dhikr.Status.APPROVED, enabled=True).first()
        if d is None:
            raise ApiError("not_found", "هذا الذكر غير متاح.", 404)
        Favorite.objects.get_or_create(user=request.user, dhikr=d)
        return Response({"favorite": True})

    def delete(self, request, pk):
        Favorite.objects.filter(user=request.user, dhikr_id=pk).delete()
        return Response({"favorite": False})


class PrefsIn(serializers.ModelSerializer):
    class Meta:
        model = Preferences
        fields = ["enabled", "interval_hours", "window_start", "window_end", "morning_on", "morning_hour", "evening_on", "evening_hour",
                  "sleep_on", "sleep_hour", "quran_dua_on", "sunnah_dua_on", "quiet_start", "quiet_end"]

    def validate_interval_hours(self, v):
        if v not in (0, 1, 2, 3, 4):
            raise serializers.ValidationError("اختر: كل ساعة، أو ساعتين، أو 3، أو 4، أو إيقاف.")
        return v

    def validate(self, a):
        for k in ("window_start", "window_end", "morning_hour", "evening_hour", "sleep_hour", "quiet_start", "quiet_end"):
            v = a.get(k, getattr(self.instance, k, 0))
            if not 0 <= v <= 23 and not (k == "window_end" and v == 24):
                raise serializers.ValidationError({k: ["ساعة غير صالحة."]})
        s, e = a.get("window_start", self.instance.window_start), a.get("window_end", self.instance.window_end)
        if s >= e:
            raise serializers.ValidationError({"window_end": ["يجب أن تنتهي الفترة بعد بدايتها."]})
        return a


class MyAdhkarSettings(APIView):
    """GET/PUT «إعدادات الأذكار والتنبيهات» (kept in PostgreSQL per account)."""

    def get(self, request):
        p = services.prefs_for(request.user)
        return Response({**PrefsIn(p).data, "timezone": request.user.timezone or "Africa/Cairo"})

    def put(self, request):
        p, _ = Preferences.objects.get_or_create(user=request.user)
        s = PrefsIn(p, data=request.data, partial=True)
        s.is_valid(raise_exception=True)
        s.save()
        return Response({**PrefsIn(p).data, "timezone": request.user.timezone or "Africa/Cairo"})


# ---- administration -----------------------------------------------------------------------------------------------
class DhikrIn(serializers.Serializer):
    category = serializers.ChoiceField(choices=Dhikr.Category.choices)
    source_type = serializers.ChoiceField(choices=Dhikr.Source.choices)
    surah = serializers.IntegerField(required=False, allow_null=True, min_value=1, max_value=114)
    ayah_from = serializers.IntegerField(required=False, allow_null=True, min_value=1)
    ayah_to = serializers.IntegerField(required=False, allow_null=True, min_value=1)
    text = serializers.CharField(required=False, allow_blank=True, max_length=4000)      # hadith only
    hadith_collection = serializers.CharField(required=False, allow_blank=True, max_length=120)
    hadith_number = serializers.CharField(required=False, allow_blank=True, max_length=40)
    grading = serializers.ChoiceField(choices=Dhikr.Grading.choices, required=False, allow_blank=True)
    graded_by = serializers.CharField(required=False, allow_blank=True, max_length=120)
    reference_url = serializers.URLField(required=False, allow_blank=True, max_length=500)
    repetition = serializers.IntegerField(required=False, allow_null=True, min_value=1, max_value=1000)
    time_of_day = serializers.ChoiceField(choices=Dhikr.Time.choices, required=False, default="any")

    def validate(self, a):
        if a["source_type"] == "quran":
            s, f, t = a.get("surah"), a.get("ayah_from"), a.get("ayah_to") or a.get("ayah_from")
            if not (s and f and t and t >= f):
                raise serializers.ValidationError({"surah": ["اختر السورة وأول آية وآخر آية."]})
            got = seed.quran_text(s, f, t)
            if got is None:
                raise serializers.ValidationError({"ayah_to": ["هذه الآيات غير موجودة في النص القرآني المعتمد."]})
            a["text"], a["quran_source"], a["ayah_to"] = got[0], got[1], t
            for k in ("hadith_collection", "hadith_number", "grading", "graded_by"):
                a[k] = ""
        else:
            miss = {k: ["مطلوب لمصدر الحديث."] for k in ("text", "hadith_collection", "hadith_number", "grading") if not (a.get(k) or "").strip()}
            if miss:
                raise serializers.ValidationError(miss)
            a["text"] = a["text"].strip()
            a["surah"] = a["ayah_from"] = a["ayah_to"] = None
            a["quran_source"] = None
        return a


SOURCE_FIELDS = ("source_type", "text", "surah", "ayah_from", "ayah_to", "hadith_collection", "hadith_number", "grading", "graded_by")


class AdminAdhkar(APIView):
    permission_classes = [IsAdminRole]
    admin_perm = {"read": "adhkar.view", "write": "adhkar.manage"}

    def get(self, request):
        qs = Dhikr.objects.select_related("created_by", "reviewed_by", "quran_source")
        st = request.query_params.get("status")
        if st in Dhikr.Status.values:
            qs = qs.filter(status=st)
        if request.query_params.get("source") in Dhikr.Source.values:
            qs = qs.filter(source_type=request.query_params["source"])
        qs = _filter(qs, request)
        pg = PageNumberPagination()
        pg.page_size = 100
        page = pg.paginate_queryset(qs.order_by("status", "category", "pk"), request, view=self)
        counts = dict(Dhikr.objects.values_list("status").annotate(n=Count("id")))
        return pg.get_paginated_response({"counts": counts, "categories": CATS, "rows": [out(d, admin=True) for d in page]})

    def post(self, request):
        s = DhikrIn(data=request.data)
        s.is_valid(raise_exception=True)
        a = s.validated_data
        if a["source_type"] == "quran" and Dhikr.objects.filter(source_type="quran", surah=a["surah"], ayah_from=a["ayah_from"], ayah_to=a["ayah_to"]).exists():
            raise ApiError("duplicate", "هذه الآيات موجودة في المكتبة بالفعل.", 409)
        d = Dhikr.objects.create(**a, status=Dhikr.Status.PENDING, origin="admin", created_by=request.user)
        audit("adhkar.created", actor=request.user, target=d, request=request, source=d.source_type, category=d.category)
        return Response(out(d, admin=True), status=201)


class AdminDhikr(APIView):
    """PATCH: edit. Changing the text or the source sends the entry back to «بانتظار المراجعة»."""

    permission_classes = [IsAdminRole]
    admin_perm = {"read": "adhkar.view", "write": "adhkar.manage"}

    def patch(self, request, pk):
        d = Dhikr.objects.filter(pk=pk).first()
        if d is None:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        cur = {k: getattr(d, k) for k in ("category", "source_type", "surah", "ayah_from", "ayah_to", "text", "hadith_collection",
                                           "hadith_number", "grading", "graded_by", "reference_url", "repetition", "time_of_day")}
        s = DhikrIn(data={**{k: v for k, v in cur.items() if v is not None}, **request.data})
        s.is_valid(raise_exception=True)
        a = s.validated_data
        changed_source = any(str(a.get(k) or "") != str(getattr(d, k) or "") for k in SOURCE_FIELDS)
        for k, v in a.items():
            setattr(d, k, v)
        if changed_source and d.status != Dhikr.Status.PENDING:
            d.status, d.reviewed_by, d.reviewed_at, d.review_note = Dhikr.Status.PENDING, None, None, ""
        d.save()
        audit("adhkar.edited", actor=request.user, target=d, request=request, back_to_review=changed_source)
        return Response(out(d, admin=True))


class AdminDhikrReview(APIView):
    """POST {decision: approve|reject, note}: only approved entries are shown or sent."""

    permission_classes = [IsAdminRole]
    admin_perm = "adhkar.approve"

    def post(self, request, pk):
        d = Dhikr.objects.filter(pk=pk).first()
        if d is None:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        dec = request.data.get("decision")
        note = str(request.data.get("note") or "").strip()[:300]
        if dec not in ("approve", "reject"):
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"decision": ["اختر اعتماد أو رفض."]})
        if dec == "reject" and len(note) < 3:
            raise ApiError("invalid", "اكتب سبب الرفض.", 400, {"note": ["اكتب سبب الرفض."]})
        if dec == "approve" and d.source_type == "quran" and seed.quran_text(d.surah, d.ayah_from, d.ayah_to) is None:
            raise ApiError("invalid", "تعذّر التحقق من الآيات في النص القرآني المعتمد.", 409)
        d.status = Dhikr.Status.APPROVED if dec == "approve" else Dhikr.Status.REJECTED
        d.reviewed_by, d.reviewed_at, d.review_note = request.user, timezone.now(), note
        d.save(update_fields=["status", "reviewed_by", "reviewed_at", "review_note", "updated_at"])
        audit(f"adhkar.{'approved' if dec == 'approve' else 'rejected'}", actor=request.user, target=d, request=request, note=note)
        return Response(out(d, admin=True))


class AdminDhikrEnable(APIView):
    permission_classes = [IsAdminRole]
    admin_perm = "adhkar.manage"

    def post(self, request, pk):
        n = Dhikr.objects.filter(pk=pk).update(enabled=request.data.get("enabled") is not False, updated_at=timezone.now())
        if not n:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        d = Dhikr.objects.get(pk=pk)
        audit("adhkar.enabled" if d.enabled else "adhkar.disabled", actor=request.user, target=d, request=request)
        return Response(out(d, admin=True))


class AdminAdhkarSeed(APIView):
    """POST: add the proposed Quranic references (text from the verified Quran) and the Sunnah entries copied verbatim
    from the hadith dataset (seed.seed_sunnah), all «بانتظار المراجعة»."""

    permission_classes = [IsAdminRole]
    admin_perm = "adhkar.manage"

    def post(self, request):
        r = seed.seed_quran(actor=request.user)
        h = seed.seed_sunnah(actor=request.user)
        r = {**r, "created": r["created"] + h["created"], "existing": r["existing"] + h["existing"], "sunnah_created": h["created"]}
        audit("adhkar.quran_references_seeded", actor=request.user, target=request.user, request=request, created=r["created"], missing=len(r["missing"]))
        return Response(r)


class AdminDhikrTest(APIView):
    """POST: send this entry to the administrator's own devices now (approved entries only)."""

    permission_classes = [IsAdminRole]
    admin_perm = "adhkar.manage"

    def post(self, request, pk):
        from django.core.cache import cache

        d = Dhikr.objects.filter(pk=pk).first()
        if d is None:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        if not d.live:
            raise ApiError("not_approved", "لا يُرسل إلا ذكر معتمد ومفعّل.", 409)
        if not cache.add(f"adhkar-test:{request.user.pk}", 1, 30):
            raise ApiError("throttled", "انتظر نصف دقيقة ثم أعد المحاولة.", 429)
        n = services.send(request.user, d, f"test:{timezone.now():%Y%m%d%H%M%S}")
        from apps.notifications.models import Notification, PushSubscription

        n = Notification.objects.get(pk=n.pk) if n else None
        devices = PushSubscription.objects.filter(user=request.user, active=True).count()
        return Response({"devices": devices, "push_status": n.push_status if n else "", "message":
                         "لا يوجد جهاز مرتبط بحسابك. اربط جهازك من «إشعارات لوحة الإدارة على هذا الجهاز»." if not devices else
                         "قبلت خدمة الإشعارات الإرسال. تأكد من ظهوره على جهازك." if n and n.push_status == "sent" else
                         f"حالة الإرسال: {n.push_status if n else 'غير معروفة'}"})


class AdminAdhkarStats(APIView):
    """Delivery statistics (last 7 days) and the latest failed deliveries (no personal data beyond the role)."""

    permission_classes = [IsAdminRole]
    admin_perm = "adhkar.view"

    def get(self, request):
        from apps.notifications.models import Notification

        since = timezone.now() - timedelta(days=7)
        notes = Notification.objects.filter(kind__startswith="adhkar_", created_at__gte=since)
        by_status = dict(notes.values_list("push_status").annotate(n=Count("id")))
        top = (Delivery.objects.filter(sent_at__gte=since).exclude(slot__startswith="test:").values("dhikr").annotate(n=Count("id")).order_by("-n")[:10])
        names = {d.pk: services.source_label(d) for d in Dhikr.objects.filter(pk__in=[t["dhikr"] for t in top])}
        failed = notes.filter(Q(push_status="failed") | Q(push_status="retry")).select_related("recipient").order_by("-created_at")[:30]
        return Response({
            "since": since.isoformat(), "notices_7d": notes.count(), "by_push_status": by_status,
            "accounts_7d": notes.values("recipient").distinct().count(),
            "top": [{"dhikr": t["dhikr"], "source": names.get(t["dhikr"], ""), "sent": t["n"]} for t in top],
            "failed": [{"at": n.created_at.isoformat(), "role": n.recipient.role, "status": n.push_status, "error": n.push_error,
                        "attempts": n.push_attempts, "dhikr": (n.data or {}).get("dhikr")} for n in failed],
            "library": dict(Dhikr.objects.values_list("status").annotate(n=Count("id"))),
        })
