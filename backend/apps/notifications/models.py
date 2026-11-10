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
    # Phone delivery (outbox): set after the transaction that created the notification commits.
    #   pending   — waiting to be sent (also what a crash between commit and send leaves; the hourly job sends it)
    #   sent      — the push service accepted it for every target device (not proof Android displayed it)
    #   no_device — the recipient has no active device: inbox only
    #   pref_off  — the recipient switched this category off
    #   retry     — a temporary failure (network, 5xx, 429): retried by the hourly job, at most PUSH_ATTEMPTS times
    #   failed    — refused by the push service, or still failing after PUSH_ATTEMPTS
    #   off       — push is not configured on the server
    push_status = models.CharField(max_length=10, blank=True, default="")
    push_attempts = models.PositiveSmallIntegerField(default=0)
    push_at = models.DateTimeField(null=True, blank=True)
    push_error = models.CharField(max_length=20, blank=True, default="")
    push_targets = models.JSONField(default=list, blank=True)  # device ids still to send to (a retry never repeats a success)

    class Meta:
        ordering = ["-created_at"]
        constraints = [models.UniqueConstraint(fields=["recipient", "dedupe_key"], name="notification_dedupe")]
        indexes = [models.Index(fields=["recipient", "read_at"]), models.Index(fields=["push_status"])]


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
    # Delivery receipt from the phone's service worker (push/receipt): the push ARRIVED on the device, and whether
    # Android displayed it ("shown") or refused ("error:<name>"). Empty = no receipt yet (old app version, or the push
    # never reached the phone).
    last_receipt_at = models.DateTimeField(null=True, blank=True)
    last_receipt = models.CharField(max_length=60, blank=True, default="")


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
