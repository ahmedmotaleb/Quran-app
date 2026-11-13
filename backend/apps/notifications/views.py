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
            # Accepted by the push service (Google, Mozilla, Apple), not proof it was shown: the phone decides that.
            n = "جهاز واحد" if r["sent"] == 1 else f"{r['sent']} أجهزة"
            msg = (f"قبلت خدمة الإشعارات الإرسال إلى {n}. تأكد من ظهوره على الهاتف: "
                   "الخادم لا يستطيع تأكيد العرض (يتحكم فيه الجهاز وإعدادات الإشعارات وتوفير البطارية).")
        return Response({**r, "message": msg})


# ---- Daily Quran reminders «تذكيرات القرآن الكريم» (students) -------------------------------------------------------
class ReminderIn(serializers.Serializer):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        from .models import ReminderSettings

        for k in ReminderSettings.KINDS:
            self.fields[f"{k}_on"] = serializers.BooleanField(required=False)
            self.fields[f"{k}_hour"] = serializers.IntegerField(required=False, min_value=0, max_value=23)
        self.fields["quiet_start"] = serializers.IntegerField(required=False, min_value=0, max_value=23)
        self.fields["quiet_end"] = serializers.IntegerField(required=False, min_value=0, max_value=23)


def reminders_out(s, user) -> dict:
    return {**{f: getattr(s, f) for k in s.KINDS for f in (f"{k}_on", f"{k}_hour")},
            "quiet_start": s.quiet_start, "quiet_end": s.quiet_end, "timezone": user.timezone or "Africa/Cairo",
            "enabled": (user.notify_prefs or {}).get("reminders", True) is not False}


class MyReminders(APIView):
    """GET/PUT the signed-in student's reminder hours (their own time zone) and quiet hours. A reminder hour inside
    the quiet hours is refused (it would never be sent). The category on/off is `notify_prefs.reminders` (PATCH me)."""

    def get_permissions(self):
        from apps.accounts.permissions import IsStudent

        return [IsStudent()]

    def get(self, request):
        from .reminders import settings_for

        return Response(reminders_out(settings_for(request.user), request.user))

    def put(self, request):
        from .models import ReminderSettings

        s = ReminderIn(data=request.data)
        s.is_valid(raise_exception=True)
        obj, _ = ReminderSettings.objects.get_or_create(user=request.user)
        for k, v in s.validated_data.items():
            setattr(obj, k, v)
        bad = {f"{k}_hour": ["هذا الوقت ضمن ساعات الهدوء؛ لن يصلك فيه تذكير. اختر وقتًا آخر أو عدّل ساعات الهدوء."]
               for k in obj.KINDS if getattr(obj, f"{k}_on") and obj.in_quiet(getattr(obj, f"{k}_hour"))}
        if bad:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, bad)
        obj.save()
        return Response(reminders_out(obj, request.user))


# ---- this device («حسابي ← الإشعارات»: حالة الإشعارات على هذا الجهاز) -------------------------------------------
SELF_TEST_SECONDS = 60
SELF_TEST_PER_HOUR = 5


class PushStatus(APIView):
    """GET ?endpoint=: the signed-in account's own push diagnostics for THIS device: server readiness, whether the
    server has this subscription (and its last delivery/failure), the account's devices, the reminder preference, time
    zone and the last daily reminder sent. Never keys or endpoints."""

    def get(self, request):
        from .reminders import settings_for

        u = request.user
        ep = request.query_params.get("endpoint", "")
        mine = PushSubscription.objects.filter(user=u, endpoint=ep).first() if ep else None
        last = (Notification.objects.filter(recipient=u, kind__startswith="reminder_").order_by("-created_at").first())
        s = settings_for(u) if u.role == "student" else None
        return Response({
            "server": push.readiness(),
            "this_device": None if mine is None else {"active": mine.active, "last_success_at": mine.last_success_at,
                                                     "last_failure": mine.last_failure, "last_failure_at": mine.last_failure_at,
                                                     "last_receipt_at": mine.last_receipt_at, "last_receipt": mine.last_receipt},
            "devices": PushSubscription.objects.filter(user=u, active=True).count(),
            "prefs": {k: (u.notify_prefs or {}).get(k, True) is not False for k in push.PREF_KEYS},
            "timezone": u.timezone,
            "reminders": None if s is None else {k: {"on": getattr(s, f"{k}_on"), "hour": getattr(s, f"{k}_hour")} for k in s.KINDS}
            | {"quiet": [s.quiet_start, s.quiet_end]},
            "last_reminder": None if last is None else {"kind": last.kind, "at": last.created_at},
        })


class PushSelfTest(APIView):
    """POST {endpoint?}: «إرسال إشعار تجريبي» to the signed-in account's own devices (this device first when given).
    Fixed text only; rate limited (1 per minute, 5 per hour). `sent` means the push service ACCEPTED it — whether the
    phone shows it is up to the phone."""

    def post(self, request):
        from django.core.cache import cache

        u = request.user
        if not push.configured():
            raise ApiError("push_not_configured", "إشعارات الجوال غير جاهزة على الخادم.", 503)
        if not cache.add(f"pushself:m:{u.pk}", 1, SELF_TEST_SECONDS):
            raise ApiError("throttled", "أُرسل إشعار تجريبي قبل قليل. انتظر دقيقة ثم أعد المحاولة.", 429)
        key = f"pushself:h:{u.pk}"
        cache.add(key, 0, 3600)
        if cache.incr(key) > SELF_TEST_PER_HOUR:
            raise ApiError("throttled", "تجاوزت حد الإشعارات التجريبية لهذه الساعة.", 429)
        ep = str(request.data.get("endpoint", "") or "")
        subs = list(PushSubscription.objects.filter(user=u, active=True))
        here = next((x for x in subs if ep and x.endpoint == ep), None)
        results = [(x is here, *push.send_one(x, push.TEST, kind="test")) for x in subs]
        this_ok = any(h and ok for h, ok, _ in results)
        sent = sum(1 for _, ok, _ in results if ok)
        failed = sorted({c for _, ok, c in results if not ok})
        audit("push.self_test", actor=u, target=u, request=request, devices=len(subs), sent=sent, failed=failed, this_device=bool(here))
        if not subs:
            msg = "لا يوجد جهاز مسجّل لهذا الحساب. اضغط «ربط الجهاز بالإشعارات» أولًا."
        elif ep and here is None:
            msg = "هذا الجهاز غير مسجّل لهذا الحساب، فلم يُرسل إليه. اضغط «ربط الجهاز بالإشعارات»."
        elif ep and not this_ok:
            msg = "رفضت خدمة الإشعارات الإرسال إلى هذا الجهاز. اضغط «ربط الجهاز بالإشعارات» ثم أعد المحاولة."
        else:
            msg = ("قبلت خدمة الإشعارات الإرسال. إن لم يظهر الإشعار خلال دقيقة فالسبب من إعدادات الهاتف: "
                   "الإشعارات أو توفير البطارية للحلقة أو Chrome.")
        return Response({"devices": len(subs), "sent": sent, "failed": failed, "this_device": bool(here), "this_device_sent": this_ok,
                         "message": msg})



class PushReceipt(APIView):
    """POST {r, ok, shown, error}: the phone's service worker reports that a push ARRIVED and whether the notification
    was displayed. No session is needed (a service worker may run with the app closed and signed out): the signed token
    from the push payload names the device. Stores only a time and a short outcome on that device's row."""

    authentication_classes: list = []
    permission_classes: list = []
    throttle_scope = "push_receipt"

    def post(self, request):
        import re

        sid = push.receipt_sub(request.data.get("r", ""))
        if sid is None:
            return Response(status=204)  # nothing to say to a forged or expired token
        if request.data.get("ok") is True:
            out = "shown" if request.data.get("shown") is not False else "not_listed"
        else:
            out = "error:" + re.sub(r"[^A-Za-z0-9_ .:-]", "", str(request.data.get("error", "")))[:40]
        PushSubscription.objects.filter(pk=sid).update(last_receipt_at=timezone.now(), last_receipt=out)
        push.log.info("push_receipt", extra={"outcome": out.split(":")[0]})
        return Response(status=204)


class PushRotate(APIView):
    """POST {old: {endpoint, keys}, new: {endpoint, keys}} from the phone's service worker when the browser replaced
    the push subscription by itself (`pushsubscriptionchange`), possibly with the app closed and no session. The old
    subscription's endpoint AND its keys must match a stored device (proof that the caller held it); that device row
    is moved to the new subscription for the same account. Never creates a device; unknown or mismatched: no change."""

    authentication_classes: list = []
    permission_classes: list = []
    throttle_scope = "push_receipt"

    def post(self, request):
        d = request.data if isinstance(request.data, dict) else {}
        old, new = d.get("old") or {}, d.get("new") or {}
        ok, nk = old.get("keys") or {}, new.get("keys") or {}
        ep = str(new.get("endpoint", ""))
        if not (ep.startswith("https://") and len(ep) <= 1000 and nk.get("p256dh") and nk.get("auth")):
            return Response(status=204)
        row = PushSubscription.objects.filter(endpoint=str(old.get("endpoint", "")), p256dh=str(ok.get("p256dh", "")), auth=str(ok.get("auth", ""))).first()
        if row is None or (row.endpoint != ep and PushSubscription.objects.filter(endpoint=ep).exists()):
            return Response(status=204)
        PushSubscription.objects.filter(pk=row.pk).update(endpoint=ep, p256dh=str(nk["p256dh"])[:200], auth=str(nk["auth"])[:100],
                                                          active=True, failures=0, last_failure="", last_failure_at=None)
        push.log.info("push_subscription_rotated", extra={"family": push.device_family(row.device)})
        return Response(status=204)

