"""In-app notifications, and the devices that opted into Web Push (Prompt 18)."""
from django.conf import settings
from django.db import models


class Notification(models.Model):
    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notifications")
    kind = models.CharField(max_length=40)  # booking_confirmed, feedback_released, ...
    title = models.CharField(max_length=160)
    body = models.CharField(max_length=500, blank=True)
    link = models.CharField(max_length=200, blank=True)  # in-app route, authorization re-checked on open
    # Safe structured metadata for navigation (ids only — never media URLs or private content).
    data = models.JSONField(default=dict, blank=True)
    dedupe_key = models.CharField(max_length=120)
    read_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [models.UniqueConstraint(fields=["recipient", "dedupe_key"], name="notification_dedupe")]
        indexes = [models.Index(fields=["recipient", "read_at"])]


class PushSubscription(models.Model):
    """One browser/device that agreed to receive push notifications (pack prompt 18). Deleting it is the opt-out;
    endpoints the push service reports as gone are removed automatically."""

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="push_subscriptions")
    endpoint = models.URLField(max_length=1000, unique=True)
    p256dh = models.CharField(max_length=200)
    auth = models.CharField(max_length=100)
    device = models.CharField(max_length=120, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_success_at = models.DateTimeField(null=True, blank=True)
    failures = models.PositiveSmallIntegerField(default=0)
