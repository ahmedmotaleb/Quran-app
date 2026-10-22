"""Arabic-first HALQA emails with a link (invitations, account setup): plain text plus a simple RTL HTML version.

The link is the only secret in the message; it is never logged. Nothing about a child's progress, grades, mistakes,
recordings or meeting links ever goes into these emails.
"""
from __future__ import annotations

import logging
from datetime import datetime
from html import escape
from zoneinfo import ZoneInfo

from django.conf import settings
from django.core.mail import EmailMultiAlternatives

log = logging.getLogger(__name__)
BRAND = "حَلْقة"


def email_configured() -> bool:
    """A real delivery backend: SMTP in production, or the file mailbox used by the end-to-end tests."""
    return "smtp" in settings.EMAIL_BACKEND or "filebased" in settings.EMAIL_BACKEND


def _support() -> str:
    from apps.core.models import AppSettings

    return AppSettings.load().support_email or "halqa.app.eg@gmail.com"


def send_link_email(to: str, *, subject: str, intro: str, cta: str, link: str, expires_at: datetime | None,
                    one_time: bool = True) -> bool:
    """Send one branded email. Returns True only when the backend reports the message as sent. Never raises."""
    if not email_configured():
        return False
    support = _support()
    until = expires_at.astimezone(ZoneInfo("Africa/Cairo")).strftime("%Y-%m-%d %H:%M") if expires_at else None
    notes = [x for x in (
        f"الرابط صالح حتى {until} (بتوقيت القاهرة)." if until else "",
        "يُستخدم الرابط مرة واحدة فقط، فلا تشاركه مع أحد." if one_time else "",
        f"للمساعدة: {support}",
        "إن لم تكن تتوقع هذه الرسالة فتجاهلها.",
    ) if x]
    text = "السلام عليكم،\n\n" + intro + "\n\n" + f"{cta}:\n{link}\n\n" + "\n".join(notes) + f"\n\n— {BRAND}"
    html = f"""<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#F7F3E8;font-family:Tahoma,Arial,sans-serif;color:#14211F">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
<p style="margin:0 0 16px;font-size:22px;font-weight:bold;color:#0F4C45">{BRAND}</p>
<div style="background:#FFFFFF;border:1px solid #E5DECB;border-radius:16px;padding:20px">
<p style="margin:0 0 12px;font-size:16px">السلام عليكم،</p>
<p style="margin:0 0 20px;font-size:16px;line-height:1.8">{escape(intro)}</p>
<p style="margin:0 0 20px;text-align:center"><a href="{escape(link, quote=True)}" style="display:inline-block;background:#0F4C45;color:#F7F3E8;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 28px;border-radius:12px">{escape(cta)}</a></p>
<p style="margin:0 0 6px;font-size:13px;color:#5B6764;line-height:1.7">{"<br>".join(escape(n) for n in notes)}</p>
<p style="margin:12px 0 0;font-size:12px;color:#5B6764;direction:ltr;text-align:left;word-break:break-all">{escape(link)}</p>
</div></div></body></html>"""
    try:
        m = EmailMultiAlternatives(subject, text, settings.DEFAULT_FROM_EMAIL, [to])
        m.attach_alternative(html, "text/html")
        return m.send() == 1
    except Exception as e:  # noqa: BLE001
        log.error("email_send_failed", extra={"subject": subject, "error": type(e).__name__, "to_domain": to.split("@")[-1]})
        return False
