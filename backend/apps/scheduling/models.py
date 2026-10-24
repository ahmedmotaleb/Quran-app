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
from django.utils import timezone

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
        # PENDING: created by the teacher, waiting for its Google Calendar event and Meet link. Not offered, not shown
        # to students and nobody notified until it becomes SCHEDULED (apps.integrations.sync).
        PENDING = "pending", "قيد التجهيز"
        SCHEDULED = "scheduled", "مجدولة"
        CANCELLED = "cancelled", "ملغاة"
        COMPLETED = "completed", "مكتملة"

    class Topic(models.TextChoices):
        HIFZ = "hifz", "حفظ"
        REVIEW = "review", "مراجعة"
        TAJWEED = "tajweed", "تجويد"
        TEST = "test", "اختبار"
        OTHER = "other", "أخرى"

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
    topic = models.CharField(max_length=10, choices=Topic.choices, blank=True)  # set on teacher-created sessions
    title = models.CharField(max_length=120, blank=True)
    prep_note = models.CharField(max_length=500, blank=True)  # shown to the booked students in HALQA, never sent to Google

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


class CircleMember(TimeStamped):
    """A student enrolled in a circle. Members are booked into every upcoming session of the circle automatically
    (apps.scheduling.membership); leaving cancels only future circle bookings, history stays."""

    circle = models.ForeignKey(Circle, on_delete=models.PROTECT, related_name="members")
    student = models.ForeignKey(User, on_delete=models.PROTECT, related_name="circle_memberships")
    active = models.BooleanField(default=True)
    created_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    ended_at = models.DateTimeField(null=True, blank=True)
    ended_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    end_reason = models.CharField(max_length=200, blank=True)

    class Meta:
        ordering = ["-active", "student__full_name"]
        constraints = [models.UniqueConstraint(fields=["circle", "student"], condition=Q(active=True), name="one_active_circle_membership")]
        indexes = [models.Index(fields=["circle", "active"]), models.Index(fields=["student", "active"])]


class BookingExcuse(TimeStamped):
    """A student's excuse for a confirmed booking (owner decision 23 Oct 2026: students no longer cancel; they ask to be
    excused and the session's teacher decides). One per booking; the booking itself is never cancelled by it.

    `status` is the effective decision. The teacher's decision (reviewed_*) and an admin's audited correction
    (override_*) are kept side by side, so the original decision stays traceable."""

    class Status(models.TextChoices):
        PENDING = "pending", "قيد المراجعة"
        APPROVED = "approved", "مقبول"
        REJECTED = "rejected", "مرفوض"

    booking = models.OneToOneField(Booking, on_delete=models.PROTECT, related_name="excuse")
    student = models.ForeignKey(User, on_delete=models.PROTECT, related_name="excuses")
    reason = models.TextField(max_length=500, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    requested_at = models.DateTimeField(default=timezone.now)
    reviewed_at = models.DateTimeField(null=True, blank=True)
    reviewed_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    teacher_status = models.CharField(max_length=10, choices=Status.choices, blank=True)  # the teacher's own decision
    teacher_response = models.CharField(max_length=500, blank=True)
    override_at = models.DateTimeField(null=True, blank=True)
    override_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    override_reason = models.CharField(max_length=200, blank=True)

    class Meta:
        indexes = [models.Index(fields=["status", "requested_at"]), models.Index(fields=["student", "status"])]


class WaitlistEntry(models.Model):
    """«الانضمام إلى قائمة الانتظار» for a full session (individual or circle). Order: joined_at, then id. When a seat
    frees, the next waiting student is offered it for a limited time; the seat is held for them (booking counts live
    offers as taken) until they accept or the offer expires and passes to the next person (apps.scheduling.waitlist)."""

    class Status(models.TextChoices):
        WAITING = "waiting", "في الانتظار"
        OFFERED = "offered", "عُرض عليه مقعد"
        BOOKED = "booked", "حُجز"
        EXPIRED = "expired", "انتهى العرض"
        CANCELLED = "cancelled", "أُلغي"
        CLOSED = "closed", "أُغلق"  # the session started, was cancelled, or the student became ineligible

    student = models.ForeignKey(User, on_delete=models.PROTECT, related_name="waitlist_entries")
    occurrence = models.ForeignKey(SessionOccurrence, on_delete=models.PROTECT, related_name="waitlist")
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.WAITING)
    joined_at = models.DateTimeField(default=timezone.now)
    offered_at = models.DateTimeField(null=True, blank=True)
    offer_expires_at = models.DateTimeField(null=True, blank=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    booking = models.ForeignKey(Booking, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        ordering = ["joined_at", "id"]
        constraints = [models.UniqueConstraint(fields=["student", "occurrence"], condition=models.Q(status__in=["waiting", "offered"]),
                                               name="one_open_waitlist_entry")]
        indexes = [models.Index(fields=["occurrence", "status", "joined_at"]), models.Index(fields=["status", "offer_expires_at"])]


class MakeupCredit(models.Model):
    """«جلسة تعويضية»: granted for one excused booking (never twice: one-to-one with the source booking). It lets the
    student book one replacement session with the same teacher before it expires."""

    class Status(models.TextChoices):
        AVAILABLE = "available", "متاحة"
        USED = "used", "استُخدمت"
        EXPIRED = "expired", "انتهت"
        REVOKED = "revoked", "أُلغيت"

    student = models.ForeignKey(User, on_delete=models.PROTECT, related_name="makeup_credits")
    teacher = models.ForeignKey(User, on_delete=models.PROTECT, related_name="+")
    source_booking = models.OneToOneField(Booking, on_delete=models.PROTECT, related_name="makeup_credit")
    issued_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    issued_at = models.DateTimeField(default=timezone.now)
    expires_at = models.DateTimeField()
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.AVAILABLE)
    used_at = models.DateTimeField(null=True, blank=True)
    used_booking = models.OneToOneField(Booking, null=True, blank=True, on_delete=models.SET_NULL, related_name="makeup_used")

    class Meta:
        ordering = ["-issued_at"]
        indexes = [models.Index(fields=["student", "status", "expires_at"])]
