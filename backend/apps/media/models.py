"""
Media metadata. File bytes live in object storage (S3-compatible, e.g. Cloudflare R2), never in
PostgreSQL. The object key is server-generated and is the permanent identity — signed URLs are
issued per request and never stored.
"""
import uuid

from django.conf import settings
from django.db import models

from apps.core.models import TimeStamped


class MediaObject(TimeStamped):
    class Purpose(models.TextChoices):
        COURSE_COVER = "course_cover", "صورة دورة"
        LESSON_FILE = "lesson_file", "ملف درس"
        RECITATION = "recitation", "تسجيل تلاوة"
        VOICE_FEEDBACK = "voice_feedback", "ملاحظة صوتية"
        SUPPORT_IMAGE = "support_image", "صورة مرفقة بطلب دعم"

    class State(models.TextChoices):
        PENDING = "pending", "بانتظار الرفع"
        UPLOADED = "uploaded", "مرفوع بانتظار التحقق"
        VALIDATED = "validated", "سليم"
        REJECTED = "rejected", "مرفوض"
        DELETED = "deleted", "محذوف"

    PRIVATE_PURPOSES = {Purpose.RECITATION, Purpose.VOICE_FEEDBACK, Purpose.SUPPORT_IMAGE}

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="media")
    purpose = models.CharField(max_length=24, choices=Purpose.choices)
    key = models.CharField(max_length=200, unique=True)
    content_type = models.CharField(max_length=100)
    size_bytes = models.PositiveBigIntegerField(null=True, blank=True)
    sha256 = models.CharField(max_length=64, blank=True)
    duration_seconds = models.FloatField(null=True, blank=True)
    state = models.CharField(max_length=16, choices=State.choices, default=State.PENDING)
    rejection_reason = models.CharField(max_length=200, blank=True)
    # Client upload id (X-Upload-ID): a retry after an ambiguous network failure gets the same object back.
    upload_key = models.CharField(max_length=64, blank=True, default="")

    class Meta:
        indexes = [models.Index(fields=["owner", "purpose", "state"])]
        constraints = [models.UniqueConstraint(fields=["owner", "upload_key"], condition=~models.Q(upload_key=""),
                                               name="media_owner_upload_key")]

    @property
    def is_private(self) -> bool:
        return self.purpose in self.PRIVATE_PURPOSES
