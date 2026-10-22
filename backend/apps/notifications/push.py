"""Web Push delivery (pack prompt 18). Optional and off until the owner configures VAPID keys
(deploy/gcp-push.sh); without them nothing is sent and the app says push is unavailable — never a fake success.

Lock-screen text is generic per category: no names, scores, Quran ranges or other learning details. Opening the
notification takes the user into the app, where the full message is shown after sign-in.
"""
from __future__ import annotations

import json
import logging

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
]
FALLBACK = ("الحلقة", "لديك إشعار جديد.")


def configured() -> bool:
    return bool(settings.VAPID_PUBLIC_KEY and settings.VAPID_PRIVATE_KEY)


def payload_for(kind: str, link: str) -> dict:
    title, body = next((v for k, v in GENERIC if kind.startswith(k)), FALLBACK)
    return {"title": title, "body": body, "url": "/#" + (link or "/inbox"), "tag": kind.split("_")[0]}


def deliver(notification) -> int:
    """Send to each of the recipient's devices. Returns how many were delivered. Never raises."""
    if not configured():
        return 0
    from pywebpush import WebPushException, webpush

    from .models import PushSubscription

    sent = 0
    data = json.dumps(payload_for(notification.kind, notification.link), ensure_ascii=False)
    for sub in PushSubscription.objects.filter(user_id=notification.recipient_id):
        try:
            webpush(subscription_info={"endpoint": sub.endpoint, "keys": {"p256dh": sub.p256dh, "auth": sub.auth}}, data=data,
                    vapid_private_key=settings.VAPID_PRIVATE_KEY, vapid_claims={"sub": settings.VAPID_SUBJECT}, ttl=6 * 3600, timeout=4)
            PushSubscription.objects.filter(pk=sub.pk).update(last_success_at=timezone.now(), failures=0)
            sent += 1
        except WebPushException as e:
            status = getattr(e.response, "status_code", None)
            if status in (404, 410):  # the browser unsubscribed or the endpoint expired
                sub.delete()
                log.info("push_endpoint_removed", extra={"status": status})
            else:
                PushSubscription.objects.filter(pk=sub.pk).update(failures=sub.failures + 1)
                log.warning("push_failed", extra={"status": status})
        except Exception as e:  # noqa: BLE001 — a push problem must never break the action that caused it
            log.warning("push_failed", extra={"error": type(e).__name__})
    return sent
