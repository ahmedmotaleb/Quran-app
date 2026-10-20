"""Courses, enrollment, memorization/review/Tajweed assignments, recitation submissions and teacher feedback."""
from django.conf import settings
from django.db import models
from django.db.models import F, Q

from apps.core.models import TimeStamped

User = settings.AUTH_USER_MODEL


class PublishState(models.TextChoices):
    DRAFT = "draft", "مسودة"
    PENDING = "pending", "بانتظار المراجعة"
    PUBLISHED = "published", "منشور"
    ARCHIVED = "archived", "مؤرشف"


class Course(TimeStamped):
    title = models.CharField(max_length=160)
    description = models.TextField(blank=True)
    topic = models.CharField(max_length=40, blank=True)  # tajweed / hifz / adab / ulum
    level = models.CharField(max_length=32, blank=True)
    teacher = models.ForeignKey(User, on_delete=models.PROTECT, related_name="courses")
    cover = models.ForeignKey("media.MediaObject", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    state = models.CharField(max_length=16, choices=PublishState.choices, default=PublishState.DRAFT)
    # False: an open library course any learner may read. True: only actively enrolled students (and its teacher).
    restricted = models.BooleanField(default=False)

    class Meta:
        indexes = [models.Index(fields=["state", "topic", "level"])]


class Lesson(TimeStamped):
    class Kind(models.TextChoices):
        TEXT = "text", "نص"
        VIDEO = "video", "فيديو"
        AUDIO = "audio", "صوت"
        PDF = "pdf", "ملف PDF"

    course = models.ForeignKey(Course, on_delete=models.CASCADE, related_name="lessons")
    order = models.PositiveSmallIntegerField(default=0)
    title = models.CharField(max_length=160)
    kind = models.CharField(max_length=8, choices=Kind.choices, default=Kind.TEXT)
    body = models.TextField(blank=True)
    external_url = models.URLField(blank=True)  # approved providers only (validated in serializer)
    media = models.ForeignKey("media.MediaObject", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    duration_minutes = models.PositiveSmallIntegerField(null=True, blank=True)
    state = models.CharField(max_length=16, choices=PublishState.choices, default=PublishState.DRAFT)

    class Meta:
        ordering = ["course", "order", "id"]


class Enrollment(TimeStamped):
    class Status(models.TextChoices):
        ACTIVE = "active", "نشط"
        COMPLETED = "completed", "مكتمل"
        WITHDRAWN = "withdrawn", "منسحب"

    student = models.ForeignKey(User, on_delete=models.PROTECT, related_name="enrollments")
    course = models.ForeignKey(Course, on_delete=models.PROTECT, related_name="enrollments")
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)
    starts_on = models.DateField(null=True, blank=True)
    ends_on = models.DateField(null=True, blank=True)
    created_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["student", "course"], condition=Q(status="active"), name="one_active_enrollment")]


class LessonCompletion(models.Model):
    """Explicit 'mark complete' by the student. Not evidence of mastery."""

    student = models.ForeignKey(User, on_delete=models.CASCADE, related_name="+")
    lesson = models.ForeignKey(Lesson, on_delete=models.CASCADE, related_name="completions")
    completed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["student", "lesson"], name="lesson_completed_once")]


class AssignmentType(models.TextChoices):
    HIFZ = "hifz", "حفظ"
    REVIEW = "review", "مراجعة"
    TAJWEED = "tajweed", "تجويد"


class AssignmentStatus(models.TextChoices):
    NOT_STARTED = "not_started", "لم تبدأ"
    IN_PROGRESS = "in_progress", "قيد التنفيذ"
    SUBMITTED = "submitted", "تم التسليم"
    ACCEPTED = "accepted", "اعتمده المعلم"
    NEEDS_REPEAT = "needs_repeat", "يحتاج إعادة"


# Allowed status transitions (enforced in services, not by the client).
ASSIGNMENT_TRANSITIONS = {
    AssignmentStatus.NOT_STARTED: {AssignmentStatus.IN_PROGRESS, AssignmentStatus.SUBMITTED},
    AssignmentStatus.IN_PROGRESS: {AssignmentStatus.SUBMITTED},
    AssignmentStatus.SUBMITTED: {AssignmentStatus.ACCEPTED, AssignmentStatus.NEEDS_REPEAT},
    AssignmentStatus.NEEDS_REPEAT: {AssignmentStatus.IN_PROGRESS, AssignmentStatus.SUBMITTED},
    AssignmentStatus.ACCEPTED: set(),
}


class Assignment(TimeStamped):
    student = models.ForeignKey(User, on_delete=models.PROTECT, related_name="assignments")
    teacher = models.ForeignKey(User, on_delete=models.PROTECT, related_name="assigned_work")
    kind = models.CharField(max_length=8, choices=AssignmentType.choices)
    title = models.CharField(max_length=160)
    surah = models.PositiveSmallIntegerField()
    ayah_from = models.PositiveSmallIntegerField()
    ayah_to = models.PositiveSmallIntegerField()
    instructions = models.TextField(blank=True)
    due_at = models.DateTimeField()
    requires_recording = models.BooleanField(default=True)
    status = models.CharField(max_length=16, choices=AssignmentStatus.choices, default=AssignmentStatus.NOT_STARTED)
    lesson = models.ForeignKey(Lesson, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    next_review_on = models.DateField(null=True, blank=True)
    # Set on review tasks generated by the spaced-repetition engine (apps.learning.reviews).
    review_schedule = models.ForeignKey("ReviewSchedule", null=True, blank=True, on_delete=models.PROTECT, related_name="tasks")
    review_cycle = models.PositiveIntegerField(null=True, blank=True)

    class Meta:
        ordering = ["due_at"]
        constraints = [
            models.CheckConstraint(condition=Q(ayah_from__gte=1) & Q(ayah_to__gte=F("ayah_from")), name="assignment_valid_range"),
            models.CheckConstraint(condition=Q(surah__gte=1, surah__lte=114), name="assignment_surah_range"),
            # One generated task per schedule cycle: retries and concurrent requests cannot duplicate it.
            models.UniqueConstraint(fields=["review_schedule", "review_cycle"], condition=Q(review_schedule__isnull=False),
                                    name="one_task_per_review_cycle"),
        ]
        indexes = [models.Index(fields=["student", "status", "due_at"]), models.Index(fields=["teacher", "status"])]


class AssignmentEvent(models.Model):
    """History of status changes: who changed what, when."""

    assignment = models.ForeignKey(Assignment, on_delete=models.CASCADE, related_name="events")
    actor = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    from_status = models.CharField(max_length=16, choices=AssignmentStatus.choices)
    to_status = models.CharField(max_length=16, choices=AssignmentStatus.choices)
    created_at = models.DateTimeField(auto_now_add=True)


class Submission(TimeStamped):
    assignment = models.ForeignKey(Assignment, on_delete=models.PROTECT, related_name="submissions")
    student = models.ForeignKey(User, on_delete=models.PROTECT, related_name="submissions")
    media = models.ForeignKey("media.MediaObject", on_delete=models.PROTECT, related_name="+")
    attempt = models.PositiveSmallIntegerField()
    duration_seconds = models.FloatField()
    idempotency_key = models.CharField(max_length=64)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(fields=["assignment", "attempt"], name="submission_attempt_unique"),
            models.UniqueConstraint(fields=["student", "idempotency_key"], name="submission_idempotent"),
        ]


class Feedback(TimeStamped):
    """Teacher's assessment of one submission. Scores are teacher judgments, never automated."""

    class Decision(models.TextChoices):
        ACCEPT = "accept", "اعتماد الحفظ"
        REPEAT = "repeat", "يحتاج إعادة"

    submission = models.OneToOneField(Submission, on_delete=models.PROTECT, related_name="feedback")
    teacher = models.ForeignKey(User, on_delete=models.PROTECT, related_name="feedback_given")
    score_hifz = models.PositiveSmallIntegerField()
    score_tajweed = models.PositiveSmallIntegerField()
    score_fluency = models.PositiveSmallIntegerField()
    decision = models.CharField(max_length=8, choices=Decision.choices)
    general = models.TextField(blank=True)
    needs_review = models.CharField(max_length=200, blank=True)
    next_step = models.CharField(max_length=200, blank=True)
    voice = models.ForeignKey("media.MediaObject", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=Q(score_hifz__range=(1, 5)) & Q(score_tajweed__range=(1, 5)) & Q(score_fluency__range=(1, 5)),
                name="feedback_scores_1_5",
            ),
            models.CheckConstraint(condition=~Q(decision="repeat") | ~Q(needs_review=""), name="repeat_requires_needs_review"),
        ]


class FeedbackNote(models.Model):
    feedback = models.ForeignKey(Feedback, on_delete=models.CASCADE, related_name="notes")
    at_seconds = models.FloatField()
    text = models.CharField(max_length=500)
    category = models.CharField(max_length=32, blank=True)  # e.g. madd, makharij, hesitation

    class Meta:
        ordering = ["at_seconds"]


class ReviewSchedule(TimeStamped):
    """Spaced review of one accepted memorization range (pack prompt 15). The Quran text itself is never copied:
    only the surah/ayah reference is kept."""

    student = models.ForeignKey(User, on_delete=models.PROTECT, related_name="review_schedules")
    teacher = models.ForeignKey(User, on_delete=models.PROTECT, related_name="+")
    source = models.OneToOneField(Assignment, on_delete=models.PROTECT, related_name="review_plan")
    surah = models.PositiveSmallIntegerField()
    ayah_from = models.PositiveSmallIntegerField()
    ayah_to = models.PositiveSmallIntegerField()
    step = models.PositiveSmallIntegerField(default=0)  # index into the configured intervals
    cycle = models.PositiveIntegerField(default=0)      # number of review tasks generated so far
    next_due = models.DateField()                       # in the student's timezone
    active = models.BooleanField(default=True)

    class Meta:
        indexes = [models.Index(fields=["student", "active", "next_due"])]


class ReviewEvent(models.Model):
    """Append-only history of a review schedule."""

    class Kind(models.TextChoices):
        SCHEDULED = "scheduled", "جُدولت"
        GENERATED = "generated", "أُنشئت مهمة"
        COMPLETED = "completed", "اكتملت"
        REPEAT = "repeat", "تحتاج إعادة"
        OVERRIDE = "override", "تعديل المعلم"
        PAUSED = "paused", "أُوقفت"
        RESUMED = "resumed", "استُؤنفت"

    schedule = models.ForeignKey(ReviewSchedule, on_delete=models.CASCADE, related_name="events")
    kind = models.CharField(max_length=12, choices=Kind.choices)
    due_on = models.DateField(null=True, blank=True)
    step = models.PositiveSmallIntegerField()
    outcome = models.CharField(max_length=40, blank=True)
    reason = models.CharField(max_length=200, blank=True)
    assignment = models.ForeignKey(Assignment, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    actor = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at", "id"]


class Correction(TimeStamped):
    """One learning point a teacher records (pack prompt 33): a structured category at a Quran reference, with
    guidance and a status. The Quran text is never copied; only surah/ayah are stored and the verified text is
    rendered from the canonical source. Each teacher correction is its own record: recurrence is counted from the
    same category at the same reference, never by merging records."""

    class Category(models.TextChoices):
        HIFZ = "hifz", "حفظ"
        OMISSION = "omission", "نسيان / سقوط"
        ADDITION = "addition", "زيادة"
        SUBSTITUTION = "substitution", "تبديل"
        ORDER = "order", "ترتيب"
        MAKHARIJ = "makharij", "نطق / مخارج"
        SIFAT = "sifat", "صفات الحروف"
        NOON_SAKINAH = "noon_sakinah", "أحكام النون الساكنة والتنوين"
        MEEM_SAKINAH = "meem_sakinah", "أحكام الميم الساكنة"
        MADD = "madd", "المدود"
        GHUNNAH = "ghunnah", "الغنة"
        TAFKHEEM = "tafkheem", "التفخيم والترقيق"
        WAQF = "waqf", "الوقف والابتداء"
        FLUENCY = "fluency", "طلاقة / تردد"
        OTHER = "other", "أخرى"

    MEMORIZATION = ("hifz", "omission", "addition", "substitution", "order")

    class Source(models.TextChoices):
        SUBMISSION = "submission", "تسجيل تلاوة"
        SESSION = "session", "جلسة مباشرة"
        TASK = "task", "مهمة حفظ"
        REVIEW = "review", "مهمة مراجعة"

    class Priority(models.TextChoices):
        MINOR = "minor", "بسيط"
        REVIEW = "review", "يحتاج مراجعة"
        IMPORTANT = "important", "مهم"

    class Status(models.TextChoices):
        NEW = "new", "جديد"
        IMPROVING = "improving", "يتحسن"
        CORRECTED = "corrected", "تم التصحيح"

    student = models.ForeignKey(User, on_delete=models.PROTECT, related_name="corrections")
    teacher = models.ForeignKey(User, on_delete=models.PROTECT, related_name="corrections_given")
    source = models.CharField(max_length=12, choices=Source.choices)
    submission = models.ForeignKey(Submission, null=True, blank=True, on_delete=models.PROTECT, related_name="corrections")
    booking = models.ForeignKey("scheduling.Booking", null=True, blank=True, on_delete=models.PROTECT, related_name="corrections")
    assignment = models.ForeignKey(Assignment, null=True, blank=True, on_delete=models.PROTECT, related_name="corrections")
    surah = models.PositiveSmallIntegerField()
    ayah = models.PositiveSmallIntegerField()
    category = models.CharField(max_length=16, choices=Category.choices)
    priority = models.CharField(max_length=10, choices=Priority.choices, default=Priority.REVIEW)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.NEW)
    note = models.CharField(max_length=500, blank=True)            # to the student (also shown to the teacher)
    guidance = models.CharField(max_length=500, blank=True)        # how to correct it (student)
    internal_note = models.CharField(max_length=500, blank=True)   # teachers and admins only; never students or parents
    resolved_at = models.DateTimeField(null=True, blank=True)
    follow_up = models.ForeignKey(Assignment, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [
            models.CheckConstraint(condition=Q(surah__gte=1, surah__lte=114) & Q(ayah__gte=1), name="correction_valid_reference"),
        ]
        indexes = [models.Index(fields=["student", "status"]), models.Index(fields=["student", "category", "surah", "ayah"])]
