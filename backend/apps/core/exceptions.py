"""Uniform API errors: {"code", "message" (Arabic), "fields"?, "request_id"}. Details stay in server logs."""
import logging

from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
from django.http import Http404
from rest_framework import exceptions, status
from rest_framework.response import Response
from rest_framework.views import exception_handler

from .logging import request_id_var

log = logging.getLogger("apps.api")

MESSAGES = {
    "not_authenticated": "يجب تسجيل الدخول أولًا.",
    "authentication_failed": "تعذّر التحقق من بيانات الدخول.",
    "permission_denied": "ليست لديك صلاحية لهذا الإجراء.",
    "not_found": "العنصر المطلوب غير موجود.",
    "method_not_allowed": "هذا الإجراء غير مدعوم.",
    "throttled": "محاولات كثيرة. حاول مرة أخرى بعد قليل.",
    "invalid": "تحقق من البيانات المُدخلة.",
    "parse_error": "صيغة الطلب غير صحيحة.",
    "unsupported_media_type": "نوع المحتوى غير مدعوم.",
    "server_error": "حدث خطأ غير متوقع من جهتنا. حاول مرة أخرى، وإن تكرر فتواصل مع الدعم.",
}


class ApiError(exceptions.APIException):
    """Business-rule error with a stable code and an Arabic message."""

    status_code = status.HTTP_400_BAD_REQUEST

    def __init__(self, code: str, message: str, http_status: int = 400, fields: dict | None = None):
        super().__init__(detail=message, code=code)
        self.status_code = http_status
        self.code = code
        self.fields = fields


def api_exception_handler(exc, context):
    if isinstance(exc, Http404):
        exc = exceptions.NotFound()
    elif isinstance(exc, DjangoPermissionDenied):
        exc = exceptions.PermissionDenied()

    response = exception_handler(exc, context)
    rid = request_id_var.get()
    if response is None:
        log.exception("unhandled_error", extra={"view": type(context.get("view")).__name__})
        return Response({"code": "server_error", "message": MESSAGES["server_error"], "request_id": rid}, status=500)

    if isinstance(exc, ApiError):
        body = {"code": exc.code, "message": str(exc.detail)}
        if exc.fields:
            body["fields"] = exc.fields
    elif isinstance(exc, exceptions.ValidationError):
        body = {"code": "invalid", "message": MESSAGES["invalid"], "fields": exc.detail}
    else:
        code = getattr(exc, "default_code", "error")
        body = {"code": code, "message": MESSAGES.get(code, str(getattr(exc, "detail", "")))}
        if isinstance(exc, exceptions.Throttled) and exc.wait:
            body["retry_after"] = int(exc.wait)
    body["request_id"] = rid
    response.data = body
    return response
