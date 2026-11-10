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
    ("teacher_pick", ("الحلقة", "تذكير: اختيار معلمك.")),
    ("teacher_assigned", ("الحلقة", "تم تعيين معلمك.")),
    ("teacher_request", ("الحلقة", "تحديث على طلب اختيار المعلم.")),
    ("reminder_reading", ("الحلقة", "حان وقت وردك من القرآن الكريم.")),
    ("reminder_hifz", ("الحلقة", "حان وقت الحفظ اليومي.")),
    ("reminder_review", ("الحلقة", "حان وقت المراجعة اليومية.")),
    ("reminder_evening", ("الحلقة", "لديك مهام لم تكتمل اليوم.")),
    ("session_reminder", ("الحلقة", "تذكير بجلسة قادمة.")),
    ("session_cancelled", ("الحلقة", "تحديث على أحد مواعيدك.")),
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
    ("admin_teacher_request", ("الحلقة · الإدارة", "طلب اختيار معلم جديد بانتظار المراجعة.")),
    ("admin_teacher_pending", ("الحلقة · الإدارة", "معلم جديد بانتظار الاعتماد.")),
    ("admin_access", ("الحلقة · الإدارة", "تحديث على صلاحياتك في لوحة الإدارة.")),
    ("admin", ("الحلقة · الإدارة", "تنبيه إداري جديد.")),
    ("student_assigned", ("الحلقة", "انضم طالب جديد إلى طلابك.")),
    ("teacher_approved", ("الحلقة", "تم اعتماد حسابك كمعلم.")),
    ("teacher_unapproved", ("الحلقة", "تحديث على اعتماد حسابك.")),
    ("support", ("الحلقة", "تحديث على طلب الدعم.")),
]

# kind prefix → preference category («الإشعارات» in حسابي). Kinds not listed (attendance warnings, suspension, excuse
# decisions, parents' child updates, admin alerts) concern the account itself and are always pushed.
CATEGORY = [("assignment", "tasks"), ("review_due", "tasks"), ("correction", "tasks"), ("lesson", "tasks"), ("quiz", "tasks"),
            ("submission", "tasks"), ("session_reminder", "sessions"), ("session_cancelled", "sessions"), ("booking", "sessions"), ("waitlist", "sessions"),
            ("makeup", "sessions"), ("circle", "sessions"), ("feedback", "feedback"), ("weekly_report", "news"), ("admin_message", "news"),
            ("reminder", "reminders"), ("teacher_pick", "reminders")]
PREF_KEYS = ("tasks", "sessions", "feedback", "news", "reminders")


def category(kind: str) -> str | None:
    return next((c for k, c in CATEGORY if kind.startswith(k)), None)


def wanted(user, kind: str) -> bool:
    c = category(kind)
    return c is None or (user.notify_prefs or {}).get(c, True) is not False
FALLBACK = ("الحلقة", "لديك إشعار جديد.")
TEST = {"title": "الحلقة", "body": "هذا إشعار تجريبي للتأكد من عمل الإشعارات.", "url": "/#/inbox", "tag": "test"}
# Every HALQA push is shown to the user, so it is sent as high urgency (RFC 8030 §5.3). Without it Google's push
# service (FCM) treats it as normal priority: an idle Android phone (Doze, screen off) holds it until a maintenance
# window and it can expire unseen — the phone then shows nothing although the push was "accepted".
PUSH_HEADERS = {"Urgency": "high"}
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


# Notices for administrators (they open the admin portal). `admin_message` is a message FROM the administration to a
# learner, so it is not one of them.
ADMIN_KINDS = ("admin_teacher_request", "admin_teacher_pending", "admin_absence", "admin_access")
ADMIN_SECTIONS = {"overview", "students", "teachers", "parents", "circles", "bookings", "excuses", "teacherRequests", "support", "admins"}


def payload_for(kind: str, link: str = "", notification_id: int | None = None, admin_section: str | None = None) -> dict:
    """Generic text + where a tap goes. With the notification's id the app opens it exactly as the inbox would
    (task, feedback, session, support ticket…) after checking the signed-in account; nothing else is in the payload.
    Notices for administrators open the admin portal's section instead (it checks the admin session and permission)."""
    title, body = next((v for k, v in GENERIC if kind.startswith(k)), FALLBACK)
    if admin_section is not None:
        sec = admin_section if admin_section in ADMIN_SECTIONS else "overview"
        return {"title": title, "body": body, "url": f"/admin/#/admin/{sec}", "tag": kind.split("_")[0] + "-" + sec}
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


RECEIPT_SALT = "halqa.push.receipt"
RECEIPT_MAX_AGE = 24 * 3600


def receipt_token(sub_id: int) -> str:
    from django.core import signing

    return signing.dumps(sub_id, salt=RECEIPT_SALT, compress=True)


def receipt_sub(token: str) -> int | None:
    from django.core import signing

    try:
        return int(signing.loads(str(token), salt=RECEIPT_SALT, max_age=RECEIPT_MAX_AGE))
    except Exception:  # noqa: BLE001 — forged, expired or malformed
        return None


def send_one(sub, payload: dict, *, kind: str = "") -> tuple[bool, str]:
    """Deliver to one device. Returns (delivered, failure category or ""). Keeps the row's state: success time,
    failure category and time; removes it when the push service says it is gone; switches it off when it can never
    work again (other keys) or after MAX_FAILURES temporary failures in a row. Never raises; never logs the endpoint."""
    from pywebpush import WebPushException, webpush

    from .models import PushSubscription

    # `r`: a signed, short-lived receipt token for THIS device, so its service worker can report that the push arrived
    # and whether Android displayed it (views.PushReceipt). It identifies nothing outside this server.
    data = json.dumps({**payload, "r": receipt_token(sub.pk)}, ensure_ascii=False)
    fam = device_family(sub.device)
    try:
        webpush(subscription_info={"endpoint": sub.endpoint, "keys": {"p256dh": sub.p256dh, "auth": sub.auth}}, data=data,
                vapid_private_key=settings.VAPID_PRIVATE_KEY, vapid_claims={"sub": settings.VAPID_SUBJECT}, ttl=6 * 3600, timeout=3,
                headers=PUSH_HEADERS)
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


# Temporary failures worth another try (the hourly job); anything else is final for that device.
TRANSIENT = {"network", "push_service", "rate_limited", "other"}
PUSH_ATTEMPTS = 3      # first send + at most two retries by the hourly job
RETRY_WINDOW_HOURS = 6  # same as the TTL: an older notice is not pushed any more (it is in the inbox)


def _admin_section(notification, role: str) -> str | None:
    """The admin portal section a notice for an administrator opens; None for the learners' app."""
    if not notification.kind.startswith(ADMIN_KINDS):
        return None
    return (notification.data or {}).get("admin_section") or "overview"


def deliver(notification) -> int:
    """Send to the recipient's active devices (if the user wants this category) and record the outcome on the
    notification (push_status). Called after the transaction that created it commits. Returns how many devices
    accepted it. Never raises."""
    from apps.accounts.models import User

    from .models import Notification, PushSubscription

    n = notification
    now = timezone.now()

    def save(status: str, error: str = "", targets: list | None = None, attempt: bool = True) -> None:
        n.push_status, n.push_error, n.push_targets, n.push_at = status, error[:20], targets or [], now
        if attempt:
            n.push_attempts += 1
        Notification.objects.filter(pk=n.pk).update(push_status=status, push_error=error[:20], push_targets=targets or [],
                                                     push_at=now, push_attempts=n.push_attempts)

    if not configured():
        save("off", attempt=False)
        return 0
    u = User.objects.filter(pk=n.recipient_id).only("notify_prefs", "role").first()
    if u is None:
        return 0
    if not wanted(u, n.kind):
        log.info("push_skipped", extra={"reason": "preference_off", "kind": _prefix(n.kind), "role": u.role})
        save("pref_off", attempt=False)
        return 0  # the user turned this category off (the in-app notification is still there)
    subs = PushSubscription.objects.filter(user_id=n.recipient_id, active=True)
    if n.push_targets:  # a retry: only the devices that have not accepted it yet
        subs = subs.filter(pk__in=n.push_targets)
    subs = list(subs)
    if not subs:
        # Inbox only: this account has not turned on notifications on any device (the usual reason a message is
        # "only in the app"). Counted in push_report; no personal data in the log.
        log.info("push_skipped", extra={"reason": "no_device", "kind": _prefix(n.kind), "role": u.role})
        save("no_device", attempt=False)
        return 0
    payload = payload_for(n.kind, n.link, n.pk, admin_section=_admin_section(n, u.role))
    ok, again, last = 0, [], ""
    for sub in subs:
        good, cat = send_one(sub, payload, kind=n.kind)
        if good:
            ok += 1
        else:
            last = cat
            if cat in TRANSIENT:
                again.append(sub.pk)
    attempts = n.push_attempts + 1
    if again and attempts < PUSH_ATTEMPTS:
        save("retry", last, again)
    elif ok and not last:
        save("sent")
    elif ok:
        save("sent", last)  # at least one device accepted it; the others failed for good
    else:
        save("failed", last)
    log.info("push_dispatch", extra={"kind": _prefix(n.kind), "role": u.role, "status": n.push_status, "devices": len(subs),
                                     "accepted": ok, "attempt": n.push_attempts})
    return ok


def retry_pending(now=None) -> dict:
    """The hourly job: send notices left `pending` (a crash between commit and send) and retry temporary failures,
    within RETRY_WINDOW_HOURS and PUSH_ATTEMPTS. Each notice is claimed with a conditional update, so two runs never
    send the same one."""
    from datetime import timedelta

    from .models import Notification

    now = now or timezone.now()
    since = now - timedelta(hours=RETRY_WINDOW_HOURS)
    stale = now - timedelta(minutes=5)  # a notice being sent right now is left alone
    out = {"retried": 0, "accepted": 0, "expired": 0}
    if not configured():
        return out
    out["expired"] = Notification.objects.filter(push_status__in=("pending", "retry"), created_at__lt=since).update(push_status="failed", push_error="expired")
    qs = Notification.objects.filter(push_status__in=("pending", "retry"), created_at__gte=since, push_attempts__lt=PUSH_ATTEMPTS)
    qs = qs.filter(models_q_stale(stale))
    for n in qs.order_by("created_at")[:500]:
        if not Notification.objects.filter(pk=n.pk, push_status=n.push_status, push_attempts=n.push_attempts).update(push_at=now):
            continue  # claimed by another run
        out["retried"] += 1
        out["accepted"] += deliver(n)
    return out


def models_q_stale(stale):
    from django.db.models import Q

    return Q(push_at__isnull=True, created_at__lt=stale) | Q(push_at__lt=stale)


def _prefix(kind: str) -> str:
    return next((k for k, _ in GENERIC if kind.startswith(k)), "other")


def send_test(user) -> dict:
    """«إرسال إشعار تجريبي»: the fixed test text to the user's active devices (preferences do not apply)."""
    from .models import PushSubscription

    subs = list(PushSubscription.objects.filter(user=user, active=True))
    results = [send_one(s, TEST, kind="test") for s in subs] if configured() else []
    return {"devices": len(subs), "sent": sum(1 for ok, _ in results if ok),
            "failed": sorted({c for ok, c in results if not ok})}
