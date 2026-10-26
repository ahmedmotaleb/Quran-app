"""Web Push delivery (pack prompt 18). Optional and off until the owner configures VAPID keys
(deploy/gcp-push.sh); without them nothing is sent and the app says push is unavailable — never a fake success.

Lock-screen text is generic per category: no names, scores, Quran ranges or other learning details. Opening the
notification takes the user into the app, where the full message is shown after sign-in.
"""
from __future__ import annotations

import base64
import json
import logging
from functools import lru_cache

from django.conf import settings
from django.utils import timezone

log = logging.getLogger(__name__)

# kind prefix → (title, body) shown on the lock screen
GENERIC = [
    ("feedback", ("الحلقة", "وصل تقييم جديد من معلمك.")),
    ("correction", ("الحلقة", "أضاف معلمك ملاحظة جديدة للمراجعة.")),
    ("assignment", ("الحلقة", "لديك واجب جديد.")),
    ("review_due", ("الحلقة", "حان موعد مراجعة.")),
    ("session_reminder", ("الحلقة", "تذكير بجلسة قادمة.")),
    ("booking", ("الحلقة", "تحديث على أحد مواعيدك.")),
    ("submission", ("الحلقة", "تسليم جديد بانتظار مراجعتك.")),
    ("attendance", ("الحلقة", "تحديث على الحضور.")),
    ("excuse_child", ("الحلقة", "تحديث عن أحد أبنائك.")),
    ("excuse", ("الحلقة", "تحديث على طلب اعتذار.")),
    ("absence_warning_child", ("الحلقة", "تحديث عن أحد أبنائك.")),
    ("absence_warning", ("الحلقة", "تنبيه بشأن الحضور.")),
    ("account_suspended_child", ("الحلقة", "تحديث عن أحد أبنائك.")),
    ("account_suspended", ("الحلقة", "تحديث على حسابك.")),
    ("admin_absence", ("الحلقة", "تنبيه إداري جديد.")),
    ("child", ("الحلقة", "تحديث عن أحد أبنائك.")),
    ("weekly_report", ("الحلقة", "ملخص الأسبوع لأبنائك جاهز.")),
    ("lesson", ("الحلقة", "محتوى جديد في دورتك.")),
    ("quiz", ("الحلقة", "اختبار جديد في دورتك.")),
    ("waitlist", ("الحلقة", "توفّر مقعد في جلسة تنتظرها.")),
    ("makeup", ("الحلقة", "مُنحت لك جلسة تعويضية.")),
    ("circle", ("الحلقة", "تحديث على حلقتك.")),
    ("admin_message", ("الحلقة", "رسالة جديدة من إدارة الحلقة.")),
    ("support", ("الحلقة", "تحديث على طلب الدعم.")),
]

# kind prefix → preference category («الإشعارات» in حسابي). Kinds not listed (attendance warnings, suspension, excuse
# decisions, parents' child updates, admin alerts) concern the account itself and are always pushed.
CATEGORY = [("assignment", "tasks"), ("review_due", "tasks"), ("correction", "tasks"), ("lesson", "tasks"), ("quiz", "tasks"),
            ("submission", "tasks"), ("session_reminder", "sessions"), ("booking", "sessions"), ("waitlist", "sessions"),
            ("makeup", "sessions"), ("circle", "sessions"), ("feedback", "feedback"), ("weekly_report", "news"), ("admin_message", "news")]
PREF_KEYS = ("tasks", "sessions", "feedback", "news")


def category(kind: str) -> str | None:
    return next((c for k, c in CATEGORY if kind.startswith(k)), None)


def wanted(user, kind: str) -> bool:
    c = category(kind)
    return c is None or (user.notify_prefs or {}).get(c, True) is not False
FALLBACK = ("الحلقة", "لديك إشعار جديد.")
TEST = {"title": "الحلقة", "body": "هذا إشعار تجريبي للتأكد من عمل الإشعارات.", "url": "/#/inbox", "tag": "test"}
MAX_FAILURES = 5  # consecutive temporary failures before a device is switched off (it re-subscribes when opened)


@lru_cache(maxsize=4)
def _keys_match(public: str, private: str) -> bool:
    """The private key must derive exactly the public key browsers subscribed with; otherwise every push is refused."""
    try:
        from cryptography.hazmat.primitives import serialization
        from py_vapid import Vapid

        pub = Vapid.from_string(private.strip()).public_key.public_bytes(serialization.Encoding.X962,
                                                                        serialization.PublicFormat.UncompressedPoint)
        return base64.urlsafe_b64encode(pub).rstrip(b"=").decode() == public.strip()
    except Exception:  # noqa: BLE001
        return False


def readiness() -> str:
    """For /api/ready: «ready» only when both keys are set AND belong together; the code alone is not readiness."""
    if not (settings.VAPID_PUBLIC_KEY and settings.VAPID_PRIVATE_KEY):
        return "not_configured"
    return "ready" if _keys_match(settings.VAPID_PUBLIC_KEY, settings.VAPID_PRIVATE_KEY) else "misconfigured"


def configured() -> bool:
    return readiness() == "ready"


def payload_for(kind: str, link: str = "", notification_id: int | None = None) -> dict:
    """Generic text + where a tap goes. With the notification's id the app opens it exactly as the inbox would
    (task, feedback, session, support ticket…) after checking the signed-in account; nothing else is in the payload."""
    title, body = next((v for k, v in GENERIC if kind.startswith(k)), FALLBACK)
    url = f"/#/n/{notification_id}" if notification_id else "/#/inbox"
    return {"title": title, "body": body, "url": url, "tag": kind.split("_")[0]}


def failure_category(status: int | None, exc: Exception | None = None) -> str:
    if status in (404, 410):
        return "gone"           # the browser unsubscribed or the endpoint expired: removed
    if status in (401, 403):
        return "unauthorized"   # the subscription belongs to other keys (keys rotated): switched off
    if status == 413:
        return "too_large"
    if status == 429:
        return "rate_limited"
    if status and status >= 500:
        return "push_service"
    if status:
        return f"http_{status}"
    return "network" if exc is not None else "other"


def device_family(ua: str) -> str:
    from .management.commands.push_report import device_family as fam

    return fam(ua)


def send_one(sub, payload: dict, *, kind: str = "") -> tuple[bool, str]:
    """Deliver to one device. Returns (delivered, failure category or ""). Keeps the row's state: success time,
    failure category and time; removes it when the push service says it is gone; switches it off when it can never
    work again (other keys) or after MAX_FAILURES temporary failures in a row. Never raises; never logs the endpoint."""
    from pywebpush import WebPushException, webpush

    from .models import PushSubscription

    data = json.dumps(payload, ensure_ascii=False)
    fam = device_family(sub.device)
    try:
        webpush(subscription_info={"endpoint": sub.endpoint, "keys": {"p256dh": sub.p256dh, "auth": sub.auth}}, data=data,
                vapid_private_key=settings.VAPID_PRIVATE_KEY, vapid_claims={"sub": settings.VAPID_SUBJECT}, ttl=6 * 3600, timeout=4)
    except WebPushException as e:
        status = getattr(e.response, "status_code", None)
        cat = failure_category(status, e)
    except Exception as e:  # noqa: BLE001 — a push problem must never break the action that caused it
        status, cat = None, failure_category(None, e)
    else:
        PushSubscription.objects.filter(pk=sub.pk).update(last_success_at=timezone.now(), failures=0, last_failure="")
        log.info("push_sent", extra={"family": fam, "category": kind.split("_")[0]})
        return True, ""
    now = timezone.now()
    if cat == "gone":
        PushSubscription.objects.filter(pk=sub.pk).delete()
        log.info("push_endpoint_removed", extra={"status": status, "family": fam})
    else:
        failures = sub.failures + 1
        off = cat == "unauthorized" or failures >= MAX_FAILURES
        PushSubscription.objects.filter(pk=sub.pk).update(failures=failures, last_failure=cat, last_failure_at=now,
                                                          active=False if off else sub.active)
        log.warning("push_failed", extra={"status": status, "category": cat, "family": fam, "switched_off": off})
    return False, cat


def deliver(notification) -> int:
    """Send to each of the recipient's active devices (if the user wants this category). Returns how many were
    delivered. Never raises."""
    if not configured():
        return 0
    from apps.accounts.models import User

    from .models import PushSubscription

    u = User.objects.filter(pk=notification.recipient_id).only("notify_prefs").first()
    if u is None or not wanted(u, notification.kind):
        return 0  # the user turned this category off (the in-app notification is still there)
    payload = payload_for(notification.kind, notification.link, notification.pk)
    return sum(send_one(sub, payload, kind=notification.kind)[0]
               for sub in PushSubscription.objects.filter(user_id=notification.recipient_id, active=True))


def send_test(user) -> dict:
    """«إرسال إشعار تجريبي»: the fixed test text to the user's active devices (preferences do not apply)."""
    from .models import PushSubscription

    subs = list(PushSubscription.objects.filter(user=user, active=True))
    results = [send_one(s, TEST, kind="test") for s in subs] if configured() else []
    return {"devices": len(subs), "sent": sum(1 for ok, _ in results if ok),
            "failed": sorted({c for ok, c in results if not ok})}
