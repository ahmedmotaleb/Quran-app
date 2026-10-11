from .logging import request_id_var
from .models import AuditEvent


def client_ip(request) -> str | None:
    return request.META.get("REMOTE_ADDR") if request is not None else None


def audit(action: str, *, actor=None, target=None, request=None, **data) -> AuditEvent:
    """Record a sensitive change. Never pass passwords, tokens or codes in `data`."""
    return AuditEvent.objects.create(
        actor=actor if (actor is not None and getattr(actor, "pk", None)) else None,
        action=action,
        target_type=target._meta.label_lower if target is not None else "",
        target_id=str(target.pk) if target is not None else "",
        data=data,
        ip=client_ip(request),
        request_id=request_id_var.get(),
    )
