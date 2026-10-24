"""Upload validation, storage and read access for private media."""
from __future__ import annotations

import hashlib
import logging
import uuid

from django.conf import settings

from apps.accounts.models import Role
from apps.accounts.permissions import assigned_student_ids
from apps.core.exceptions import ApiError

from .models import MediaObject
from .storage import StorageError, get_storage

log = logging.getLogger(__name__)

# Declared type → (file extension, signature check). The bytes must match the declared type.
AUDIO_TYPES = {
    "audio/webm": ("webm", lambda h: h[:4] == b"\x1a\x45\xdf\xa3"),
    "audio/ogg": ("ogg", lambda h: h[:4] == b"OggS"),
    "audio/mp4": ("m4a", lambda h: h[4:8] == b"ftyp"),
    "audio/x-m4a": ("m4a", lambda h: h[4:8] == b"ftyp"),
    "audio/aac": ("aac", lambda h: h[:2] in (b"\xff\xf1", b"\xff\xf9")),
    "audio/mpeg": ("mp3", lambda h: h[:3] == b"ID3" or (h[0] == 0xFF and (h[1] & 0xE0) == 0xE0)),
    "audio/wav": ("wav", lambda h: h[:4] == b"RIFF" and h[8:12] == b"WAVE"),
    "audio/x-wav": ("wav", lambda h: h[:4] == b"RIFF" and h[8:12] == b"WAVE"),
}

INVALID_FILE = "الملف ليس تسجيلًا صوتيًا مدعومًا."


def limits(purpose: str) -> tuple[int, int]:
    """Effective size/length limits: the admin setting for recitations, never above the server's hard cap."""
    from apps.core.models import AppSettings

    max_bytes, max_secs = settings.MEDIA_MAX_BYTES[purpose], settings.MEDIA_MAX_SECONDS[purpose]
    if purpose == MediaObject.Purpose.RECITATION:
        cfg = AppSettings.load()
        max_bytes = min(max_bytes, cfg.max_upload_mb * 1024 * 1024)
        max_secs = min(max_secs, cfg.max_recording_seconds)
    return max_bytes, max_secs


PDF_TYPE = {"application/pdf": ("pdf", lambda h: h[:5] == b"%PDF-")}


def store_audio(*, owner, purpose: str, upload, duration_seconds, upload_key: str = "") -> MediaObject:
    """Validates type (declared + magic bytes), size and duration; streams to private storage.
    Lesson files may also be PDFs, and their duration is optional (a PDF has none)."""
    if settings.MEDIA_STORAGE == "none":
        # Honest failure: the server has no recordings storage yet (owner must configure STORAGE_*).
        raise ApiError("storage_not_configured", "رفع التسجيلات غير مفعّل على الخادم بعد. سيتاح قريبًا بإذن الله.", 503)
    declared = (upload.content_type or "").split(";")[0].strip().lower()
    types = {**AUDIO_TYPES, **PDF_TYPE} if purpose == MediaObject.Purpose.LESSON_FILE else AUDIO_TYPES
    if declared not in types:
        raise ApiError("invalid_file", INVALID_FILE, 400, {"file": [INVALID_FILE]})
    max_bytes, max_secs = limits(purpose)
    if upload.size == 0:
        raise ApiError("empty_file", "التسجيل فارغ.", 400, {"file": ["التسجيل فارغ."]})
    if upload.size > max_bytes:
        mb = max_bytes // (1024 * 1024)
        raise ApiError("file_too_large", f"حجم التسجيل أكبر من {mb} ميغابايت.", 413, {"file": [f"الحد الأقصى {mb} ميغابايت."]})
    optional = purpose == MediaObject.Purpose.LESSON_FILE and duration_seconds in (None, "")
    try:
        dur = None if optional else float(duration_seconds)
    except (TypeError, ValueError):
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"duration_seconds": ["أدخل مدة صحيحة."]}) from None
    if dur is not None and not 1 <= dur <= max_secs:
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"duration_seconds": ["مدة التسجيل خارج الحد المسموح."]})

    ext, sniff = types[declared]
    f = upload.open("rb")
    head = f.read(16)
    if len(head) < 12 or not sniff(head):
        raise ApiError("invalid_file", INVALID_FILE, 400, {"file": [INVALID_FILE]})
    f.seek(0)
    digest = hashlib.sha256()
    for chunk in iter(lambda: f.read(1024 * 1024), b""):
        digest.update(chunk)
    f.seek(0)

    mid = uuid.uuid4()
    # Server-generated key: no user-controlled path components.
    key = f"{purpose}/{owner.pk}/{mid}.{ext}"
    m = MediaObject.objects.create(id=mid, owner=owner, purpose=purpose, key=key, content_type=declared,
                                   size_bytes=upload.size, sha256=digest.hexdigest(), duration_seconds=dur, upload_key=upload_key)
    try:
        get_storage().save(key, f, declared)
    except StorageError as e:
        log.error("media_store_failed", extra={"purpose": purpose, "error": type(e.__cause__ or e).__name__, "bytes": upload.size})
        m.state = MediaObject.State.REJECTED
        m.rejection_reason = "storage_error"
        m.upload_key = ""  # the retry with the same upload id may try again
        m.save(update_fields=["state", "rejection_reason", "upload_key", "updated_at"])
        raise ApiError("storage_unavailable", "تعذّر حفظ التسجيل الآن. حاول مرة أخرى بعد قليل.", 503) from None
    # Type, signature, size and checksum were verified above; transcoding/virus scanning is not in scope yet.
    m.state = MediaObject.State.VALIDATED
    m.save(update_fields=["state", "updated_at"])
    return m


SUPPORT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
SUPPORT_IMAGE_MAX_PIXELS = 4096 * 4096
IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}
INVALID_IMAGE = "أرفق صورة فقط (PNG أو JPEG أو WebP) بحجم 5 ميغابايت كحد أقصى."


def store_support_image(*, owner, upload) -> MediaObject:
    """A screenshot for a support ticket: images only. The picture is decoded and re-encoded as PNG/JPEG, which drops
    EXIF (location, device) and anything hidden after the image data; audio, video, PDFs and recordings are refused."""
    from io import BytesIO

    from PIL import Image, UnidentifiedImageError

    if settings.MEDIA_STORAGE == "none":
        raise ApiError("storage_not_configured", "إرفاق الصور غير مفعّل على الخادم بعد.", 503)
    declared = (upload.content_type or "").split(";")[0].strip().lower()
    if declared not in IMAGE_TYPES or not 0 < upload.size <= SUPPORT_IMAGE_MAX_BYTES:
        raise ApiError("invalid_file", INVALID_IMAGE, 413 if upload.size > SUPPORT_IMAGE_MAX_BYTES else 400, {"image": [INVALID_IMAGE]})
    Image.MAX_IMAGE_PIXELS = SUPPORT_IMAGE_MAX_PIXELS
    try:
        with Image.open(upload.open("rb")) as im:
            if im.format not in ("PNG", "JPEG", "WEBP"):
                raise ApiError("invalid_file", INVALID_IMAGE, 400, {"image": [INVALID_IMAGE]})
            im.load()
            keep_alpha = im.mode in ("RGBA", "LA", "P")
            clean = im.convert("RGBA" if keep_alpha else "RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, ValueError):
        raise ApiError("invalid_file", INVALID_IMAGE, 400, {"image": [INVALID_IMAGE]}) from None
    out = BytesIO()
    if keep_alpha:
        clean.save(out, "PNG", optimize=True)
        ctype, ext = "image/png", "png"
    else:
        clean.save(out, "JPEG", quality=85)
        ctype, ext = "image/jpeg", "jpg"
    data = out.getvalue()
    mid = uuid.uuid4()
    key = f"support_image/{owner.pk}/{mid}.{ext}"
    m = MediaObject.objects.create(id=mid, owner=owner, purpose=MediaObject.Purpose.SUPPORT_IMAGE, key=key, content_type=ctype,
                                   size_bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
    try:
        get_storage().save(key, BytesIO(data), ctype)
    except StorageError as e:
        log.error("media_store_failed", extra={"purpose": "support_image", "error": type(e.__cause__ or e).__name__, "bytes": len(data)})
        m.state, m.rejection_reason = MediaObject.State.REJECTED, "storage_error"
        m.save(update_fields=["state", "rejection_reason", "updated_at"])
        raise ApiError("storage_unavailable", "تعذّر حفظ الصورة الآن. حاول مرة أخرى بعد قليل.", 503) from None
    m.state = MediaObject.State.VALIDATED
    m.save(update_fields=["state", "updated_at"])
    return m


def can_read(user, m: MediaObject) -> bool:
    """Recordings are private: owner, the student's assigned teacher (once submitted, or in a submitted quiz), admins.
    Voice feedback: its teacher, and the student whose submission it answers. Parents: never."""
    if not user.is_authenticated or m.state != MediaObject.State.VALIDATED:
        return False
    if m.owner_id == user.pk:
        return True
    if m.purpose == MediaObject.Purpose.SUPPORT_IMAGE:  # the requester (owner, above) and support staff only
        from apps.accounts.admin_access import has

        from apps.accounts.admin_access import acts_as_admin

        return acts_as_admin(user) and has(user, "support.view")
    from apps.accounts.admin_access import acts_as_admin

    if acts_as_admin(user):  # private recordings and voice notes: submissions.view; content files: courses.view
        from apps.accounts.admin_access import has

        return has(user, "courses.view" if m.purpose in (MediaObject.Purpose.LESSON_FILE, MediaObject.Purpose.COURSE_COVER)
                   else "submissions.view")
    from apps.learning.models import Feedback, Submission

    if m.purpose == MediaObject.Purpose.RECITATION and user.role == Role.TEACHER:
        from apps.assessments.models import Answer

        mine = assigned_student_ids(user)
        return (Submission.objects.filter(media=m, student_id__in=mine).exists()
                or Answer.objects.filter(recording=m, attempt__student_id__in=mine).exclude(attempt__status="in_progress").exists())
    if m.purpose in (MediaObject.Purpose.LESSON_FILE, MediaObject.Purpose.COURSE_COVER):
        from apps.learning.models import Lesson

        from django.db.models import Q

        # Learning content: files of published lessons the user may read (restricted courses: enrolled only).
        return Lesson.objects.filter(media=m, state="published", course__state="published").filter(
            Q(course__restricted=False) | Q(course__teacher=user)
            | Q(course__enrollments__student=user, course__enrollments__status="active")).exists()
    if m.purpose == MediaObject.Purpose.VOICE_FEEDBACK and user.role == Role.STUDENT:
        return Feedback.objects.filter(voice=m, submission__student=user).exists()
    return False


def read_url(m: MediaObject, request=None) -> dict:
    url, exp = get_storage().read_url(m.key, media_id=str(m.id), request=request)
    return {"url": url, "expires_at": exp.isoformat()}
