from datetime import timedelta

import pytest
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.accounts.models import GuardianLink, TeacherAssignment
from apps.core.exceptions import ApiError
from apps.learning import services
from apps.learning.models import Assignment, AssignmentEvent, Feedback, Submission
from apps.media.models import MediaObject


def task(w, **kw):
    fields = dict(student=w.s1, teacher=w.t1, kind="hifz", title="حفظ", surah=67, ayah_from=1, ayah_to=5, due_at=timezone.now() + timedelta(days=1))
    return Assignment.objects.create(**{**fields, **kw})


@pytest.mark.django_db
def test_invalid_ranges_rejected_by_database(world):
    with pytest.raises(IntegrityError), transaction.atomic():
        task(world, ayah_from=5, ayah_to=3)
    with pytest.raises(IntegrityError), transaction.atomic():
        Assignment.objects.create(student=world.s1, teacher=world.t1, kind="hifz", title="x", surah=115, ayah_from=1, ayah_to=1, due_at=timezone.now())


@pytest.mark.django_db
def test_status_transitions_are_enforced_and_recorded(world):
    a = task(world)
    services.transition(a, "in_progress", actor=world.s1)
    with pytest.raises(ApiError):
        services.transition(a, "accepted", actor=world.t1)  # must be submitted first
    services.transition(a, "submitted", actor=world.s1)
    services.transition(a, "needs_repeat", actor=world.t1)
    assert list(AssignmentEvent.objects.filter(assignment=a).values_list("to_status", flat=True).order_by("id")) == [
        "in_progress", "submitted", "needs_repeat"]


@pytest.mark.django_db
def test_feedback_constraints(world):
    a = task(world)
    m = MediaObject.objects.create(owner=world.s1, purpose="recitation", key="k/1", content_type="audio/webm")
    s = Submission.objects.create(assignment=a, student=world.s1, media=m, attempt=1, duration_seconds=30, idempotency_key="x")
    base = dict(submission=s, teacher=world.t1, score_hifz=4, score_tajweed=4, score_fluency=4)
    with pytest.raises(IntegrityError), transaction.atomic():
        Feedback.objects.create(**base, decision="repeat")  # repeat needs "what to review"
    with pytest.raises(IntegrityError), transaction.atomic():
        Feedback.objects.create(**{**base, "score_hifz": 6}, decision="accept")
    Feedback.objects.create(**base, decision="repeat", needs_review="الآيات 3–5")
    with pytest.raises(IntegrityError), transaction.atomic():
        Submission.objects.create(assignment=a, student=world.s1, media=m, attempt=2, duration_seconds=30, idempotency_key="x")  # same key


@pytest.mark.django_db
def test_one_open_link_and_one_active_assignment_per_pair(world):
    with pytest.raises(IntegrityError), transaction.atomic():
        GuardianLink.objects.create(guardian=world.p1, student=world.s1, status="pending")
    with pytest.raises(IntegrityError), transaction.atomic():
        TeacherAssignment.objects.create(teacher=world.t1, student=world.s1)


@pytest.mark.django_db
def test_archived_users_keep_history(world):
    """PROTECT foreign keys: deleting a student with teaching records is refused (archive instead)."""
    task(world)
    from django.db.models import ProtectedError
    with pytest.raises(ProtectedError):
        world.s1.delete()
