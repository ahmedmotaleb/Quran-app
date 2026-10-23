"""In-app support tickets (PROMPT 49). A learner, teacher or parent opens a ticket; admins with support permissions
answer, assign and change its state. Internal notes are staff-only and never leave the admin API."""
from django.conf import settings
from django.db import models
from django.utils import timezone

from apps.core.models import TimeStamped


class Ticket(TimeStamped):
    class Category(models.TextChoices):
        ACCOUNT = "account", "الدخول والحساب"
        BOOKING = "booking", "الحجز والجلسات"
        RELATIONSHIP = "relationship", "العلاقة بين المعلم والطالب"
        TECHNICAL = "technical", "مشكلة تقنية"
        PAYMENT = "payment", "الدفع"  # reserved: not offered until payments exist
        OTHER = "other", "أخرى"

    class Status(models.TextChoices):
        OPEN = "open", "مفتوح"
        IN_PROGRESS = "in_progress", "قيد المعالجة"
        WAITING_USER = "waiting_user", "بانتظار ردّك"
        RESOLVED = "resolved", "تم الحل"
        CLOSED = "closed", "مغلق"

    requester = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="support_tickets")
    category = models.CharField(max_length=16, choices=Category.choices)
    subject = models.CharField(max_length=160)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.OPEN)
    assignee = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    last_activity_at = models.DateTimeField(default=timezone.now)
    resolved_at = models.DateTimeField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-last_activity_at"]
        indexes = [models.Index(fields=["status", "-last_activity_at"]), models.Index(fields=["requester", "-last_activity_at"])]


class TicketMessage(models.Model):
    ticket = models.ForeignKey(Ticket, on_delete=models.PROTECT, related_name="messages")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    body = models.TextField(max_length=4000)
    internal = models.BooleanField(default=False)  # staff note: never shown to the requester
    attachment = models.ForeignKey("media.MediaObject", null=True, blank=True, on_delete=models.PROTECT, related_name="support_messages")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at", "id"]
