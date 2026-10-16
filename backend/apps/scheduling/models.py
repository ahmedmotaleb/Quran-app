"""
Teacher availability, concrete session occurrences, bookings and attendance.

Integrity is enforced by PostgreSQL, not only by application code:
- a teacher cannot have two overlapping live occurrences (exclusion constraint on tstzrange);
- a student cannot hold two active bookings for the same occurrence (partial unique index);
- booking creation is idempotent per (student, idempotency_key).
Capacity and student-overlap checks run inside a transaction with row/advisory locks (see services).
"""
from django.conf import settings
from django.contrib.postgres.constraints import ExclusionConstraint
from django.contrib.postgres.fields import RangeOperators
from django.db import models
from django.db.models import F, Func, Q

from apps.core.models import TimeStamped

User = settings.AUTH_USER_MODEL


class TsTzRange(Func):
    function = "TSTZRANGE"
    output_field = models.Field()


class AvailabilityRule(TimeStamped):
    """Weekly window in the teacher's own timezone, e.g. Sunday 16:00–21:00 Africa/Cairo."""

    teacher = models.ForeignKey(User, on_delete=models.CASCADE, related_name="availability_rules")
    weekday = models.PositiveSmallIntegerField()  # 0 = Monday … 6 = Sunday (Python convention)
    start_time = models.TimeField()
    end_time = models.TimeField()  # may be earlier than start_time for an overnight window
    timezone = models.CharField(max_length=64, default="Africa/Cairo")
    session_minutes = models.PositiveSmallIntegerField(default=45)
    buffer_minutes = models.PositiveSmallIntegerField(default=0)
    valid_from = models.DateField()
    valid_until = models.DateField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(weekday__gte=0, weekday__lte=6), name="weekday_range")]


class AvailabilityException(TimeStamped):
    class Kind(models.TextChoices):
        OFF = "off", "إجازة"
        EXTRA = "extra", "إتاحة إضافية"

    teacher = models.ForeignKey(User, on_delete=models.CASCADE, related_name="availability_exceptions")
    date = models.DateField()
    kind = models.CharField(max_length=8, choices=Kind.choices)
    start_time = models.TimeField(null=True, blank=True)  # null = whole day (for OFF)
    end_time = models.TimeField(null=True, blank=True)
    reason = models.CharField(max_length=200, blank=True)


class Circle(TimeStamped):
    """A recurring group class (حلقة جماعية)."""

    class State(models.TextChoices):
        DRAFT = "draft", "مسودة"
        PUBLISHED = "published", "منشورة"
        OFF = "off", "موقوفة"

    name = models.CharField(max_length=120)
    teacher = models.ForeignKey(User, on_delete=models.PROTECT, related_name="circles")
    level = models.CharField(max_length=32, blank=True)
    capacity = models.PositiveSmallIntegerField()
    schedule_note = models.CharField(max_length=120, blank=True)
    state = models.CharField(max_length=12, choices=State.choices, default=State.DRAFT)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(capacity__gte=2, capacity__lte=40), name="circle_capacity_range")]


class SessionOccurrence(TimeStamped):
    class Kind(models.TextChoices):
        INDIVIDUAL = "individual", "فردية"
        GROUP = "group", "جماعية"

    class Status(models.TextChoices):
        SCHEDULED = "scheduled", "مجدولة"
        CANCELLED = "cancelled", "ملغاة"
        COMPLETED = "completed", "مكتملة"

    teacher = models.ForeignKey(User, on_delete=models.PROTECT, related_name="occurrences")
    original_teacher = models.ForeignKey(User, null=True, blank=True, on_delete=models.PROTECT, related_name="+")  # set on substitution
    kind = models.CharField(max_length=12, choices=Kind.choices, default=Kind.INDIVIDUAL)
    circle = models.ForeignKey(Circle, null=True, blank=True, on_delete=models.PROTECT, related_name="occurrences")
    starts_at = models.DateTimeField()
    ends_at = models.DateTimeField()
    capacity = models.PositiveSmallIntegerField(default=1)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.SCHEDULED)
    source_rule = models.ForeignKey(AvailabilityRule, null=True, blank=True, on_delete=models.SET_NULL, related_name="occurrences")
    meeting_provider = models.CharField(max_length=32, blank=True)
    meeting_url = models.URLField(max_length=500, blank=True)  # participant link; only via the join endpoint and to its teacher
    summary = models.TextField(blank=True)

    class Meta:
        ordering = ["starts_at"]
        constraints = [
            models.CheckConstraint(condition=Q(ends_at__gt=F("starts_at")), name="occurrence_positive_length"),
            models.CheckConstraint(condition=Q(capacity__gte=1, capacity__lte=40), name="occurrence_capacity_range"),
            ExclusionConstraint(
                name="teacher_no_overlapping_sessions",
                expressions=[(TsTzRange("starts_at", "ends_at"), RangeOperators.OVERLAPS), ("teacher", RangeOperators.EQUAL)],
                condition=~Q(status="cancelled"),
            ),
        ]
        indexes = [models.Index(fields=["teacher", "starts_at"]), models.Index(fields=["status", "starts_at"])]


class Booking(TimeStamped):
    class Status(models.TextChoices):
        CONFIRMED = "confirmed", "مؤكدة"
        CANCELLED = "cancelled", "ملغاة"

    class Attendance(models.TextChoices):
        UNMARKED = "", "—"
        PRESENT = "present", "حضر"
        LATE = "late", "متأخر"
        ABSENT = "absent", "غاب"
        EXCUSED = "excused", "غاب بعذر"

    occurrence = models.ForeignKey(SessionOccurrence, on_delete=models.PROTECT, related_name="bookings")
    student = models.ForeignKey(User, on_delete=models.PROTECT, related_name="bookings")
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.CONFIRMED)
    assignment = models.ForeignKey("learning.Assignment", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    note = models.CharField(max_length=500, blank=True)
    idempotency_key = models.CharField(max_length=64)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    cancelled_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    cancel_reason = models.CharField(max_length=200, blank=True)
    rescheduled_from = models.ForeignKey("self", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    attendance = models.CharField(max_length=8, choices=Attendance.choices, blank=True, default="")
    attendance_marked_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    attendance_marked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["occurrence", "student"], condition=Q(status="confirmed"), name="one_active_booking_per_occurrence"),
            models.UniqueConstraint(fields=["student", "idempotency_key"], name="booking_idempotent"),
        ]
        indexes = [models.Index(fields=["student", "status"])]
