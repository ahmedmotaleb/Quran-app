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


class NotificationDetail(generics.RetrieveAPIView):
    """One of the caller's own notifications (a tapped phone notification opens it in the app)."""

    serializer_class = NotificationSerializer

    def get_queryset(self):
        return Notification.objects.filter(recipient=self.request.user)


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
    """Whether push is ready on this server, the public key browsers need (the only key ever sent), and whether THIS
    device (`?endpoint=`) is registered and active for this account."""

    def get(self, request):
        endpoint = request.query_params.get("endpoint", "")
        mine = PushSubscription.objects.filter(user=request.user, endpoint=endpoint).first() if endpoint else None
        ready = push.configured()
        return Response({"enabled": ready, "status": push.readiness(), "public_key": settings.VAPID_PUBLIC_KEY if ready else None,
                         "this_device": bool(mine and mine.active), "this_device_inactive": bool(mine and not mine.active),
                         "devices": PushSubscription.objects.filter(user=request.user, active=True).count()})


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
        # (Re)registering switches the device back on: a new subscription, or the same one after a failure.
        PushSubscription.objects.update_or_create(endpoint=ep, defaults={
            "user": request.user, "p256dh": str(keys["p256dh"])[:200], "auth": str(keys["auth"])[:100], "device": device, "failures": 0,
            "active": True, "last_failure": "", "last_failure_at": None})
        return Response({"subscribed": True}, status=201)

    def delete(self, request):
        """Opt out on this device (the app also unsubscribes the browser)."""
        n, _ = PushSubscription.objects.filter(user=request.user, endpoint=str(request.data.get("endpoint", ""))).delete()
        return Response({"removed": n})


# ---- admin diagnostics («الإشعارات على الأجهزة» in a person's record) -------------------------------------------
from apps.accounts.permissions import IsAdminRole  # noqa: E402
from apps.core.audit import audit  # noqa: E402

TEST_PER_TARGET_SECONDS = 60
TEST_PER_ADMIN = (10, 3600)  # at most 10 test notifications per admin per hour


def _person(pk):
    from apps.accounts.models import User

    u = User.objects.filter(pk=pk).exclude(status="deleted").first()
    if u is None:
        raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
    return u


def device_out(s: PushSubscription) -> dict:
    """Operational facts only: never the endpoint, the p256dh/auth keys or the full user agent."""
    return {"id": s.pk, "active": s.active, "family": push.device_family(s.device), "created_at": s.created_at.isoformat(),
            "last_success_at": s.last_success_at.isoformat() if s.last_success_at else None,
            "last_failure": s.last_failure, "last_failure_at": s.last_failure_at.isoformat() if s.last_failure_at else None}


class AdminPushDevices(APIView):
    """GET: the person's registered devices (safe diagnostics) and whether push is ready on the server."""

    permission_classes = [IsAdminRole]
    admin_perm = "notifications.send"

    def get(self, request, pk):
        u = _person(pk)
        return Response({"status": push.readiness(),
                         "results": [device_out(s) for s in PushSubscription.objects.filter(user=u).order_by("-created_at")]})


class AdminPushTest(APIView):
    """POST: «إرسال إشعار تجريبي» — the fixed test text («الحلقة» / «هذا إشعار تجريبي…») to the person's ACTIVE devices.
    No payload is accepted. Rate limited per person and per admin; audited (counts only)."""

    permission_classes = [IsAdminRole]
    admin_perm = "notifications.send"

    def post(self, request, pk):
        from django.core.cache import cache

        u = _person(pk)
        if not push.configured():
            raise ApiError("push_not_configured", "إشعارات الجوال غير جاهزة على الخادم.", 503)
        if not cache.add(f"pushtest:t:{u.pk}", 1, TEST_PER_TARGET_SECONDS):
            raise ApiError("throttled", "أُرسل إشعار تجريبي لهذا المستخدم قبل قليل. انتظر دقيقة ثم أعد المحاولة.", 429)
        key = f"pushtest:a:{request.user.pk}"
        cache.add(key, 0, TEST_PER_ADMIN[1])
        if cache.incr(key) > TEST_PER_ADMIN[0]:
            raise ApiError("throttled", "تجاوزت حد الإشعارات التجريبية لهذه الساعة.", 429)
        r = push.send_test(u)
        audit("admin.push_test", actor=request.user, target=u, request=request, devices=r["devices"], sent=r["sent"], failed=r["failed"])
        if r["devices"] == 0:
            msg = "لا توجد أجهزة مفعّل عليها الإشعارات لهذا المستخدم."
        elif r["sent"] == 0:
            msg = "تعذّر إرسال الإشعار إلى أجهزة هذا المستخدم. راجع حالة الأجهزة أدناه."
        else:
            msg = "تم إرسال الإشعار إلى جهاز واحد." if r["sent"] == 1 else f"تم إرسال الإشعار إلى {r['sent']} أجهزة."
        return Response({**r, "message": msg})
