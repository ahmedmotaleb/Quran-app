"""SMS providers for phone verification codes. Credentials come from the environment (Secret Manager when deployed).

`configured()` is False without a provider: phone verification is then unavailable and the rest of the app works as
before. Message bodies (they contain codes) are never logged.
"""
from __future__ import annotations

import base64
import json
import logging
import urllib.parse
import urllib.request

from django.conf import settings

log = logging.getLogger("halqa.sms")


class SmsProvider:
    name = "none"

    def send(self, to: str, body: str) -> bool:  # pragma: no cover - interface
        raise NotImplementedError


class FileProvider(SmsProvider):
    """End-to-end tests: one JSON line per message. Never used when deployed."""

    name = "file"

    def send(self, to, body):
        with open(settings.SMS_FILE_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps({"to": to, "body": body}, ensure_ascii=False) + "\n")
        return True


class TwilioProvider(SmsProvider):
    name = "twilio"

    def send(self, to, body):
        data = {"To": to, "Body": body}
        if settings.TWILIO_MESSAGING_SERVICE_SID:
            data["MessagingServiceSid"] = settings.TWILIO_MESSAGING_SERVICE_SID
        else:
            data["From"] = settings.TWILIO_FROM
        req = urllib.request.Request(
            f"https://api.twilio.com/2010-04-01/Accounts/{settings.TWILIO_ACCOUNT_SID}/Messages.json",
            data=urllib.parse.urlencode(data).encode(), method="POST",
            headers={"Authorization": "Basic " + base64.b64encode(f"{settings.TWILIO_ACCOUNT_SID}:{settings.TWILIO_AUTH_TOKEN}".encode()).decode()})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return 200 <= r.status < 300
        except Exception as e:  # noqa: BLE001 - provider errors are reported as "not sent"
            log.warning("sms_send_failed", extra={"provider": self.name, "error": type(e).__name__})
            return False


def provider() -> SmsProvider | None:
    p = settings.SMS_PROVIDER
    if p == "file" and settings.SMS_FILE_PATH and not getattr(settings, "IS_DEPLOYED", False):
        return FileProvider()
    if p == "twilio" and settings.TWILIO_ACCOUNT_SID and settings.TWILIO_AUTH_TOKEN and (settings.TWILIO_FROM or settings.TWILIO_MESSAGING_SERVICE_SID):
        return TwilioProvider()
    return None


def configured() -> bool:
    return provider() is not None


def status() -> str:
    p = provider()
    return p.name if p else "not_configured"


def send(to: str, body: str) -> bool:
    p = provider()
    return bool(p and p.send(to, body))
