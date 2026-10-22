"""Admin portal: platform settings and the audit log (pack prompt 08), plus the public settings the apps read."""
from __future__ import annotations

from django.conf import settings
from rest_framework import serializers
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.permissions import IsAdminRole

from .audit import audit
from .exceptions import ApiError
from .models import AppSettings, AuditEvent
from .pagination import StandardPagination


def _page(view, request, qs, fn):
    p = StandardPagination()
    return p.get_paginated_response([fn(x) for x in p.paginate_queryset(qs, request, view=view)])


class AdminView(APIView):
    permission_classes = [IsAdminRole]


# ---- Settings and audit ---------------------------------------------------------------
class SettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = AppSettings
        fields = ["org_name", "support_email", "support_whatsapp", "show_support_button", "default_timezone", "cancel_hours",
                  "excuse_deadline_minutes", "join_minutes", "individual_minutes", "group_minutes", "booking_horizon_days", "booking_lead_minutes",
                  "open_signup", "session_reminders", "parent_weekly_report", "max_recording_seconds", "max_upload_mb", "review_intervals",
                  "updated_at"]
        read_only_fields = ["updated_at"]
        extra_kwargs = {"cancel_hours": {"max_value": 168}, "booking_horizon_days": {"min_value": 1, "max_value": 90},
                        "booking_lead_minutes": {"max_value": 10080}, "max_recording_seconds": {"min_value": 30, "max_value": 3600},
                        "max_upload_mb": {"min_value": 1, "max_value": 100}, "individual_minutes": {"min_value": 10, "max_value": 240},
                        "group_minutes": {"min_value": 10, "max_value": 240}, "join_minutes": {"max_value": 60},
                        "excuse_deadline_minutes": {"max_value": 10080}}

    def validate_review_intervals(self, v):
        if v in (None, []):
            return []
        if (not isinstance(v, list) or not 1 <= len(v) <= 10 or any(not isinstance(x, int) or isinstance(x, bool) or not 1 <= x <= 365 for x in v)
                or any(b <= a for a, b in zip(v, v[1:]))):
            raise serializers.ValidationError("من 1 إلى 10 أعداد صحيحة متزايدة بين 1 و365 يومًا.")
        return v

    def validate_default_timezone(self, v):
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError):
            raise serializers.ValidationError("منطقة زمنية غير معروفة (مثال: Africa/Cairo).") from None
        return v


# Changing these affects who can join or what learners can upload: the admin re-enters their password.
SENSITIVE = {"open_signup", "max_upload_mb", "max_recording_seconds", "default_timezone"}


class AdminSettingsView(AdminView):
    admin_perm = {"read": "settings.view", "write": "settings.manage"}
    def get(self, request):
        return Response({**SettingsSerializer(AppSettings.load()).data, "sensitive": sorted(SENSITIVE)})

    def patch(self, request):
        obj = AppSettings.load()
        data = {k: v for k, v in request.data.items() if k != "current_password"}
        s = SettingsSerializer(obj, data=data, partial=True)
        s.is_valid(raise_exception=True)
        changed = {k: [getattr(obj, k), v] for k, v in s.validated_data.items() if getattr(obj, k) != v}
        if SENSITIVE & set(changed) and not request.user.check_password(str(request.data.get("current_password", ""))):
            audit("admin.settings_reauth_failed", actor=request.user, target=obj, request=request, fields=sorted(SENSITIVE & set(changed)))
            raise ApiError("reauth_required", "أدخل كلمة مرورك لتأكيد تغيير الإعدادات الحساسة.", 403,
                           {"current_password": ["كلمة المرور مطلوبة أو غير صحيحة."]})
        if changed:
            s.save(updated_by=request.user)
            audit("admin.settings_changed", actor=request.user, target=obj, request=request,
                  changed={k: [str(a), str(b)] for k, (a, b) in changed.items()})
        return Response({**SettingsSerializer(AppSettings.load()).data, "sensitive": sorted(SENSITIVE)})


class PublicSettings(APIView):
    """What the learner app needs to know (no secrets, no admin data). Cached briefly by clients."""

    authentication_classes: list = []
    permission_classes = [AllowAny]

    def get(self, request):
        from apps.accounts.sms import configured as sms_configured
        from apps.media.services import limits

        c = AppSettings.load()
        max_bytes, max_secs = limits("recitation")
        return Response({"org_name": c.org_name, "support_email": c.support_email, "show_support_button": c.show_support_button,
                         "support_whatsapp": c.support_whatsapp if c.show_support_button else "", "open_signup": c.open_signup,
                         "default_timezone": c.default_timezone, "cancel_hours": c.cancel_hours, "join_minutes": c.join_minutes,
                         "excuse_deadline_minutes": c.excuse_deadline_minutes,
                         "booking_horizon_days": c.booking_horizon_days, "max_recording_seconds": max_secs,
                         "max_upload_mb": max_bytes // (1024 * 1024),
                         # «تأكيد رقم الهاتف» is offered only when an SMS provider is configured.
                         "phone_verification": sms_configured(),
                         # null while no licensed recitation source is approved: the Mushaf then plays no audio.
                         "ayah_audio": _ayah_audio(),
                         "app_url": settings.APP_URL, "admin_url": settings.ADMIN_URL})


def _ayah_audio():
    from apps.quran import qf_audio

    if qf_audio.configured():  # licensed: Quran Foundation (URLs per surah from quran/audio/<n>)
        return {"provider": "qf", "name": f"{settings.QF_RECITER_NAME} · Quran.com", "url": "", "default": settings.QF_RECITATION_ID,
                "reciters": [{"id": i, "name": n} for i, n in settings.QF_RECITERS]}
    if settings.AYAH_AUDIO_URL:
        return {"provider": "template", "url": settings.AYAH_AUDIO_URL, "name": settings.AYAH_AUDIO_NAME}
    return None


class AdminAudit(AdminView):
    admin_perm = "audit.view"
    def get(self, request):
        qs = AuditEvent.objects.select_related("actor").order_by("-created_at", "-id")
        p = request.query_params
        if p.get("action"):
            qs = qs.filter(action__startswith=p["action"])
        if p.get("target_type"):
            qs = qs.filter(target_type=p["target_type"], target_id=p.get("target_id", ""))
        return _page(self, request, qs, lambda e: {
            "id": e.id, "at": e.created_at.isoformat(), "action": e.action, "actor": e.actor.full_name if e.actor else None,
            "target": f"{e.target_type}:{e.target_id}", "data": e.data})
