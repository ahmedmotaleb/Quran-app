"""Phone numbers: E.164 normalization, masking, and one-time verification codes sent by SMS.

A phone number becomes a sign-in identifier only after its owner proves it with a code (`phone_verified_at`). A
verified number belongs to one account (partial unique constraint). Changing the number verifies the new one first;
the old number stays in place until then. Codes: 6 digits, stored only as an HMAC, valid 5 minutes, at most 5 tries,
used once; sending is limited (resend cooldown, per account and per number per hour). Without an SMS provider,
phone verification is unavailable and nothing else changes (email sign-in still works).
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import timedelta

import phonenumbers
from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.core.audit import audit
from apps.core.exceptions import ApiError

from . import sms

INVALID = ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"phone": ["اكتب رقم هاتف صحيحًا، مثل 01012345678 أو ‎+201012345678."]})


def normalize(raw: str, region: str | None = None) -> str:
    """E.164 (`+201012345678`) or '' when the text is not a valid number. Arabic-Indic digits are accepted."""
    text = str(raw or "").strip().translate(str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789"))
    if not text or "@" in text:
        return ""
    if text.startswith("00"):
        text = "+" + text[2:]
    try:
        n = phonenumbers.parse(text, None if text.startswith("+") else (region or settings.PHONE_DEFAULT_REGION))
    except phonenumbers.NumberParseException:
        return ""
    if not phonenumbers.is_valid_number(n):
        return ""
    return phonenumbers.format_number(n, phonenumbers.PhoneNumberFormat.E164)


def mask(e164: str) -> str:
    """`+20•••••••678`: country code and the last 3 digits."""
    p = str(e164 or "")
    if len(p) < 7:
        return "•" * len(p)
    head = p[:3] if p.startswith("+") else p[:2]
    return head + "•" * (len(p) - len(head) - 3) + p[-3:]


def _hash(code: str, phone: str) -> str:
    return hmac.new(settings.SECRET_KEY.encode(), f"phone-code:{phone}:{code}".encode(), hashlib.sha256).hexdigest()


def available() -> bool:
    return sms.configured()


def _owned_by_other(user, phone: str) -> bool:
    from .models import User

    return User.objects.filter(phone_e164=phone, phone_verified_at__isnull=False).exclude(pk=user.pk).exists()


def start(user, raw_phone: str, request=None) -> dict:
    """Send a code to the number (the account's verified number, if any, stays until the code is confirmed)."""
    from .models import PhoneVerification

    if not available():
        raise ApiError("sms_unavailable", "تأكيد رقم الهاتف غير متاح حاليًا. يمكنك الدخول بالبريد الإلكتروني كالمعتاد.", 503)
    phone = normalize(raw_phone)
    if not phone:
        raise INVALID
    if user.phone_e164 == phone and user.phone_verified_at:
        raise ApiError("already_verified", "هذا الرقم مؤكد في حسابك بالفعل.", 409, {"phone": ["الرقم مؤكد بالفعل."]})
    if _owned_by_other(user, phone):
        # Same answer shape as any refusal; no account details.
        raise ApiError("phone_unavailable", "لا يمكن استخدام هذا الرقم. استخدم رقمًا آخر أو تواصل مع الدعم.", 409, {"phone": ["لا يمكن استخدام هذا الرقم."]})
    now = timezone.now()
    hour = now - timedelta(hours=1)
    last = PhoneVerification.objects.filter(user=user).order_by("-created_at").first()
    if last and (now - last.created_at).total_seconds() < settings.PHONE_RESEND_SECONDS:
        wait = int(settings.PHONE_RESEND_SECONDS - (now - last.created_at).total_seconds()) + 1
        raise ApiError("resend_wait", f"انتظر {wait} ثانية قبل طلب رمز جديد.", 429, {"resend_in": [str(wait)]})
    if (PhoneVerification.objects.filter(user=user, created_at__gte=hour).count() >= settings.PHONE_SENDS_PER_HOUR
            or PhoneVerification.objects.filter(phone_e164=phone, created_at__gte=hour).count() >= settings.PHONE_SENDS_PER_HOUR):
        raise ApiError("too_many_codes", "طلبت رموزًا كثيرة. حاول بعد ساعة.", 429)
    code = f"{secrets.randbelow(10**6):06d}"
    with transaction.atomic():
        PhoneVerification.objects.filter(user=user, consumed_at__isnull=True).update(consumed_at=now, outcome="replaced")
        v = PhoneVerification.objects.create(user=user, phone_e164=phone, code_hash=_hash(code, phone),
                                             expires_at=now + timedelta(minutes=settings.PHONE_CODE_MINUTES))
    sent = sms.send(phone, f"رمز تأكيد رقمك في حَلْقة: {code}\nصالح {settings.PHONE_CODE_MINUTES} دقائق. لا تشاركه مع أحد.")
    audit("phone.code_sent", actor=user, target=user, request=request, phone=mask(phone), sent=sent)
    if not sent:
        PhoneVerification.objects.filter(pk=v.pk).update(consumed_at=timezone.now(), outcome="send_failed")
        raise ApiError("sms_failed", "تعذّر إرسال الرسالة الآن. حاول بعد قليل.", 502)
    return {"phone": mask(phone), "expires_in": settings.PHONE_CODE_MINUTES * 60, "resend_in": settings.PHONE_RESEND_SECONDS}


def confirm(user, code: str, request=None):
    """Check the code; on success the number replaces the account's previous one."""
    from .models import PhoneVerification, User

    code = str(code or "").strip()
    wrong = ApiError("code_invalid", "الرمز غير صحيح أو انتهت صلاحيته. اطلب رمزًا جديدًا إن لزم.", 400, {"code": ["رمز غير صحيح."]})
    failed = False
    with transaction.atomic():
        v = (PhoneVerification.objects.select_for_update().filter(user=user, consumed_at__isnull=True)
             .order_by("-created_at").first())
        if v is None or v.expires_at <= timezone.now():
            raise wrong
        if not hmac.compare_digest(v.code_hash, _hash(code, v.phone_e164)):
            # Saved before refusing (an error raised inside this block would roll the count back).
            v.attempts += 1
            if v.attempts >= settings.PHONE_CODE_ATTEMPTS:
                v.consumed_at, v.outcome = timezone.now(), "too_many_attempts"
            v.save(update_fields=["attempts", "consumed_at", "outcome"])
            audit("phone.verify_failed", actor=user, target=user, request=request, phone=mask(v.phone_e164), attempts=v.attempts)
            failed = True
        else:
            v.consumed_at, v.outcome = timezone.now(), "verified"
            v.save(update_fields=["consumed_at", "outcome"])
    if failed:
        raise wrong
    old = user.phone_e164 if user.phone_verified_at else ""
    try:
        with transaction.atomic():
            User.objects.filter(pk=user.pk).update(phone_e164=v.phone_e164, phone=v.phone_e164, phone_verified_at=timezone.now())
            audit("phone.verified", actor=user, target=user, request=request, phone=mask(v.phone_e164), replaced=mask(old) if old else "")
    except IntegrityError:  # verified by another account meanwhile (the code is used up either way)
        raise ApiError("phone_unavailable", "لا يمكن استخدام هذا الرقم. استخدم رقمًا آخر أو تواصل مع الدعم.", 409) from None
    user.refresh_from_db()
    return user
