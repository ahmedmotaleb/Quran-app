from django.conf import settings
from django.http import FileResponse, Http404
from rest_framework.parsers import MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.permissions import IsStudent, IsTeacher
from apps.core.audit import audit
from apps.core.exceptions import ApiError

from . import services
from .models import MediaObject
from .storage import get_storage, verify_read_token

NOT_FOUND = ApiError("not_found", "العنصر المطلوب غير موجود.", 404)


def _out(m: MediaObject, request) -> dict:
    return {"id": str(m.id), "purpose": m.purpose, "content_type": m.content_type, "size_bytes": m.size_bytes,
            "duration_seconds": m.duration_seconds, "state": m.state, **services.read_url(m, request)}


class _Upload(APIView):
    parser_classes = [MultiPartParser]
    throttle_scope = "upload"
    purpose = ""

    def post(self, request):
        f = request.FILES.get("file")
        if f is None:
            raise ApiError("invalid", "أرفق ملف التسجيل.", 400, {"file": ["أرفق ملف التسجيل."]})
        m = services.store_audio(owner=request.user, purpose=self.purpose, upload=f, duration_seconds=request.data.get("duration_seconds"))
        audit("media.uploaded", actor=request.user, target=m, request=request, purpose=self.purpose, size=m.size_bytes)
        return Response(_out(m, request), status=201)


class RecitationUpload(_Upload):
    """Student uploads a recitation. It stays private until attached to a submission."""

    permission_classes = [IsStudent]
    purpose = MediaObject.Purpose.RECITATION


class VoiceFeedbackUpload(_Upload):
    permission_classes = [IsTeacher]
    purpose = MediaObject.Purpose.VOICE_FEEDBACK


class MediaDetail(APIView):
    """Short-lived read URL for media the caller may access. Anything else is a 404."""

    def get(self, request, pk):
        m = MediaObject.objects.filter(pk=pk).first()
        if m is None or not services.can_read(request.user, m):
            raise NOT_FOUND
        return Response(_out(m, request))


class MediaContent(APIView):
    """Development storage only: streams a file for a valid, unexpired signed token."""

    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request, pk):
        if settings.MEDIA_STORAGE != "local" or not verify_read_token(request.query_params.get("t", ""), str(pk)):
            raise Http404
        m = MediaObject.objects.filter(pk=pk, state=MediaObject.State.VALIDATED).first()
        if m is None:
            raise Http404
        resp = FileResponse(get_storage().open(m.key), content_type=m.content_type)
        resp["Cache-Control"] = "private, no-store"
        resp["Content-Disposition"] = "inline"
        return resp
