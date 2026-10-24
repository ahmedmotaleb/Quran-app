"""Google Calendar + Google Meet for HALQA sessions (owner request 24 Oct).

A teacher connects their own Google account (OAuth, Calendar events scope). Each HALQA session occurrence created by
the teacher gets exactly ONE Google Calendar event on the teacher's calendar, with a Google Meet conference created
by Google. HALQA keeps scheduling, bookings, attendance and evaluation; Google Meet is only the call.
"""
import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.core.models import TimeStamped


class GoogleCalendarConnection(TimeStamped):
    class Status(models.TextChoices):
        ACTIVE = "active", "متصل"
        RECONNECT = "reconnect_required", "يحتاج إعادة ربط"
        REVOKED = "revoked", "غير متصل"

    teacher = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="google_calendar")
    google_account_email = models.EmailField(blank=True)
    encrypted_refresh_token = models.TextField(blank=True)  # Fernet; never sent to the browser, logs or audit data
    scopes = models.CharField(max_length=500, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.ACTIVE)
    connected_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):  # never the token
        return f"google:{self.teacher_id}:{self.status}"


def _event_id() -> str:
    # Google event ids allow base32hex characters (0-9, a-v); a hex UUID qualifies. Chosen by HALQA BEFORE the first
    # insert, so a retry after a timeout reuses it and Google refuses a second copy (409) instead of duplicating.
    return "halqa" + uuid.uuid4().hex


class GoogleEvent(TimeStamped):
    class Sync(models.TextChoices):
        PENDING = "pending", "قيد الإنشاء"
        READY = "ready", "جاهز"
        FAILED = "failed", "تعذّر الإنشاء"
        RECONNECT = "reconnect_required", "يحتاج إعادة ربط Google"
        CANCELLED = "cancelled", "ملغى"

    occurrence = models.OneToOneField("scheduling.SessionOccurrence", on_delete=models.PROTECT, related_name="google_event")
    teacher = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    student = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    creation_key = models.CharField(max_length=64)  # the teacher's request id: a double submit returns the same session
    event_id = models.CharField(max_length=64, unique=True, default=_event_id)
    request_id = models.UUIDField(unique=True, default=uuid.uuid4)  # conferenceData.createRequest.requestId, reused on retry
    calendar_id = models.CharField(max_length=200, default="primary")
    meet_url = models.URLField(max_length=300, blank=True)  # only as returned by Google
    conference_id = models.CharField(max_length=100, blank=True)
    html_link = models.URLField(max_length=1000, blank=True)
    sync_status = models.CharField(max_length=20, choices=Sync.choices, default=Sync.PENDING)
    last_error = models.CharField(max_length=40, blank=True)  # a code, never Google's message
    attempts = models.PositiveSmallIntegerField(default=0)
    last_synced_at = models.DateTimeField(null=True, blank=True)
    cancel_pending = models.BooleanField(default=False)  # cancelled in HALQA, Google not yet told
    attendees_hash = models.CharField(max_length=64, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["teacher", "creation_key"], name="google_event_once_per_request")]
        indexes = [models.Index(fields=["sync_status"]), models.Index(fields=["cancel_pending"], condition=Q(cancel_pending=True), name="google_event_cancel_pending")]
