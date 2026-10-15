"""Tests with versioned questions. Answer keys never leave the server; grading happens server-side."""
from django.conf import settings
from django.db import models
from django.utils import timezone
from django.db.models import Q

from apps.core.models import TimeStamped

User = settings.AUTH_USER_MODEL


class Test(TimeStamped):
    class State(models.TextChoices):
        DRAFT = "draft", "مسودة"
        PENDING = "pending", "بانتظار المراجعة"
        PUBLISHED = "published", "منشور"
        CLOSED = "closed", "مغلق"

    title = models.CharField(max_length=160)
    course = models.ForeignKey("learning.Course", null=True, blank=True, on_delete=models.PROTECT, related_name="tests")
    author = models.ForeignKey(User, on_delete=models.PROTECT, related_name="tests_authored")
    topic = models.CharField(max_length=40, blank=True)
    level = models.CharField(max_length=32, blank=True)
    state = models.CharField(max_length=12, choices=State.choices, default=State.DRAFT)
    opens_at = models.DateTimeField(null=True, blank=True)
    closes_at = models.DateTimeField(null=True, blank=True)
    duration_minutes = models.PositiveSmallIntegerField(null=True, blank=True)
    max_attempts = models.PositiveSmallIntegerField(default=1)
    release_results = models.BooleanField(default=True)  # objective scores shown immediately


class Question(models.Model):
    class Kind(models.TextChoices):
        MCQ = "mcq", "اختيار من متعدد"
        TRUE_FALSE = "true_false", "صح أو خطأ"
        SHORT = "short", "إجابة قصيرة"
        RECITATION = "recitation", "سؤال تلاوة"

    test = models.ForeignKey(Test, on_delete=models.CASCADE, related_name="questions")
    order = models.PositiveSmallIntegerField(default=0)
    version = models.PositiveSmallIntegerField(default=1)
    kind = models.CharField(max_length=12, choices=Kind.choices)
    prompt = models.TextField()
    options = models.JSONField(default=list, blank=True)
    answer_key = models.JSONField(null=True, blank=True)  # server only
    points = models.PositiveSmallIntegerField(default=1)
    retired = models.BooleanField(default=False)  # edits create a new version; old one is retired
    created_at = models.DateTimeField(default=timezone.now)
    retired_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["order", "id"]


class Attempt(TimeStamped):
    class Status(models.TextChoices):
        IN_PROGRESS = "in_progress", "جارٍ"
        SUBMITTED = "submitted", "مُسلّم"
        GRADED = "graded", "مُصحّح"

    test = models.ForeignKey(Test, on_delete=models.PROTECT, related_name="attempts")
    student = models.ForeignKey(User, on_delete=models.PROTECT, related_name="attempts")
    number = models.PositiveSmallIntegerField(default=1)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.IN_PROGRESS)
    started_at = models.DateTimeField(auto_now_add=True)
    deadline_at = models.DateTimeField(null=True, blank=True)
    submitted_at = models.DateTimeField(null=True, blank=True)
    objective_score = models.PositiveSmallIntegerField(null=True, blank=True)
    objective_max = models.PositiveSmallIntegerField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["test", "student", "number"], name="attempt_number_unique")]


class Answer(models.Model):
    attempt = models.ForeignKey(Attempt, on_delete=models.CASCADE, related_name="answers")
    question = models.ForeignKey(Question, on_delete=models.PROTECT, related_name="+")  # the version answered
    response = models.JSONField(null=True, blank=True)
    recording = models.ForeignKey("media.MediaObject", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    is_correct = models.BooleanField(null=True)
    points_awarded = models.PositiveSmallIntegerField(null=True, blank=True)
    graded_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    graded_at = models.DateTimeField(null=True, blank=True)
    grade_reason = models.CharField(max_length=200, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["attempt", "question"], name="one_answer_per_question")]
