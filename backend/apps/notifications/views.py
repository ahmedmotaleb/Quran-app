from django.utils import timezone
from rest_framework import generics, serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Notification


class NotificationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Notification
        fields = ["id", "kind", "title", "body", "link", "data", "read_at", "created_at"]


class NotificationList(generics.ListAPIView):
    """Newest first, paginated. `?unread=1` for unread only. Due session reminders are created on the way in."""

    serializer_class = NotificationSerializer

    def get_queryset(self):
        from .services import ensure_session_reminders

        ensure_session_reminders(self.request.user)
        qs = Notification.objects.filter(recipient=self.request.user).order_by("-created_at", "-id")
        if self.request.query_params.get("unread") == "1":
            qs = qs.filter(read_at__isnull=True)
        return qs


class UnreadCount(APIView):
    def get(self, request):
        from .services import ensure_session_reminders

        ensure_session_reminders(request.user)
        return Response({"unread": Notification.objects.filter(recipient=request.user, read_at__isnull=True).count()})


class NotificationRead(APIView):
    def post(self, request):
        ids = request.data.get("ids")
        qs = Notification.objects.filter(recipient=request.user, read_at__isnull=True)
        if isinstance(ids, list):
            qs = qs.filter(pk__in=[i for i in ids if isinstance(i, int)])
        return Response({"updated": qs.update(read_at=timezone.now())})


# ---- Web Push devices (pack prompt 18) ---------------------------------------------------
from django.conf import settings  # noqa: E402

from apps.core.exceptions import ApiError  # noqa: E402

from . import push  # noqa: E402
from .models import PushSubscription  # noqa: E402


class PushConfig(APIView):
    """Whether push is available on this server, the public key browsers need, and whether this device is on."""

    def get(self, request):
        endpoint = request.query_params.get("endpoint", "")
        on = bool(endpoint) and PushSubscription.objects.filter(user=request.user, endpoint=endpoint).exists()
        return Response({"enabled": push.configured(), "public_key": settings.VAPID_PUBLIC_KEY if push.configured() else None,
                         "this_device": on, "devices": PushSubscription.objects.filter(user=request.user).count()})


class PushSubscriptions(APIView):
    def post(self, request):
        if not push.configured():
            raise ApiError("push_not_configured", "إشعارات الجوال غير مفعّلة على الخادم بعد.", 503)
        ep = str(request.data.get("endpoint", ""))
        keys = request.data.get("keys") or {}
        if not ep.startswith("https://") or len(ep) > 1000 or not keys.get("p256dh") or not keys.get("auth"):
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"endpoint": ["اشتراك غير صالح."]})
        device = str(request.headers.get("User-Agent", ""))[:120]
        # An endpoint belongs to one browser: if another account used it on a shared device, it moves to this one.
        PushSubscription.objects.update_or_create(endpoint=ep, defaults={
            "user": request.user, "p256dh": str(keys["p256dh"])[:200], "auth": str(keys["auth"])[:100], "device": device, "failures": 0})
        return Response({"subscribed": True}, status=201)

    def delete(self, request):
        """Opt out on this device (the app also unsubscribes the browser)."""
        n, _ = PushSubscription.objects.filter(user=request.user, endpoint=str(request.data.get("endpoint", ""))).delete()
        return Response({"removed": n})
