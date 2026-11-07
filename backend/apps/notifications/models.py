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
    failures = models.PositiveSmallIntegerField(default=0)  # consecutive
    # Off after a failure that cannot recover (other keys) or MAX_FAILURES in a row; the app re-subscribes it when
    # opened. Nothing is sent to inactive devices. Diagnostics keep only a category, never the endpoint or keys.
    active = models.BooleanField(default=True)
    last_failure = models.CharField(max_length=20, blank=True)
    last_failure_at = models.DateTimeField(null=True, blank=True)


class ReminderSettings(models.Model):
    """A student's daily Quran reminders «تذكيرات القرآن الكريم» (hours in the student's own time zone, `User.timezone`).
    Sent by the hourly maintenance job (`quran_reminders`), only to students with an active push device, at most one
    per run, never inside quiet hours, and only when there is something left to do today."""

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="reminders")
    reading_on = models.BooleanField(default=True)       # «ورد القراءة»: skipped once the student has read today
    reading_hour = models.PositiveSmallIntegerField(default=20)
    hifz_on = models.BooleanField(default=True)          # «الحفظ»: only with an open memorization task
    hifz_hour = models.PositiveSmallIntegerField(default=17)
    review_on = models.BooleanField(default=True)        # «المراجعة»: only with a review task due by today
    review_hour = models.PositiveSmallIntegerField(default=18)
    evening_on = models.BooleanField(default=True)       # «تذكير آخر اليوم»: only for tasks due today and not done
    evening_hour = models.PositiveSmallIntegerField(default=21)
    quiet_start = models.PositiveSmallIntegerField(default=23)  # nothing is sent from quiet_start until quiet_end
    quiet_end = models.PositiveSmallIntegerField(default=7)
    updated_at = models.DateTimeField(auto_now=True)

    KINDS = ("reading", "hifz", "review", "evening")

    def in_quiet(self, hour: int) -> bool:
        s, e = self.quiet_start, self.quiet_end
        return s != e and ((s <= hour < e) if s < e else (hour >= s or hour < e))
