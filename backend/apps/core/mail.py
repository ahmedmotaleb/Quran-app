"""Email backends.

SuppressedBackend is used in deployments without an email provider: it records that a message was NOT sent
(subject and recipient domain only) and never writes the body — reset links and setup links are secrets and must
not reach logs. Admins hand out setup links from the portal instead (admin/users/<id>/setup-link).
"""
import logging

from django.core.mail.backends.base import BaseEmailBackend

log = logging.getLogger("halqa.mail")


class SuppressedBackend(BaseEmailBackend):
    def send_messages(self, email_messages):
        for m in email_messages:
            log.warning("email_not_sent_no_provider", extra={"subject": m.subject, "to_domains": sorted({a.split("@")[-1] for a in m.to})})
        return 0  # nothing was delivered
