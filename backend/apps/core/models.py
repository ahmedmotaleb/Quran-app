from django.conf import settings
from django.db import models


class TimeStamped(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class AuditEvent(models.Model):
    """Append-only record of sensitive changes (who, what, on which object, when)."""

    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    action = models.CharField(max_length=64)
    target_type = models.CharField(max_length=64, blank=True)
    target_id = models.CharField(max_length=64, blank=True)
    data = models.JSONField(default=dict, blank=True)
    ip = models.GenericIPAddressField(null=True, blank=True)
    request_id = models.CharField(max_length=64, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["target_type", "target_id"]), models.Index(fields=["action", "-created_at"])]

    def __str__(self):
        return f"{self.created_at:%Y-%m-%d %H:%M} {self.action} {self.target_type}:{self.target_id}"


class AppSettings(models.Model):
    """Public, admin-editable platform settings (singleton row, pk=1). Secrets never live here."""

    org_name = models.CharField(max_length=120, default="الحلقة لتعليم القرآن")
    support_email = models.EmailField(default="support@halqa.app")
    support_whatsapp = models.CharField(max_length=32, blank=True)
    show_support_button = models.BooleanField(default=False)
    default_timezone = models.CharField(max_length=64, default="Africa/Cairo")
    cancel_hours = models.PositiveSmallIntegerField(default=12)
    join_minutes = models.PositiveSmallIntegerField(default=10)
    individual_minutes = models.PositiveSmallIntegerField(default=45)
    group_minutes = models.PositiveSmallIntegerField(default=60)
    booking_horizon_days = models.PositiveSmallIntegerField(default=21)
    booking_lead_minutes = models.PositiveSmallIntegerField(default=60)
    open_signup = models.BooleanField(default=True)
    session_reminders = models.BooleanField(default=True)
    parent_weekly_report = models.BooleanField(default=True)
    max_recording_seconds = models.PositiveSmallIntegerField(default=900)
    max_upload_mb = models.PositiveSmallIntegerField(default=25)
    # Spaced-repetition intervals in days (product defaults, not a pedagogical guarantee).
    review_intervals = models.JSONField(default=list, blank=True)
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    DEFAULT_REVIEW_INTERVALS = [1, 3, 7, 14, 30]

    @property
    def intervals(self) -> list[int]:
        return self.review_intervals or self.DEFAULT_REVIEW_INTERVALS

    @classmethod
    def load(cls) -> "AppSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj
