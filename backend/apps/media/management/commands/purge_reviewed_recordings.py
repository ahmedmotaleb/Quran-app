"""Deletes student recordings 48 hours after the teacher reviewed them (owner decision, 16 October 2026).

Covered: a task recording once its feedback is 48 h old, and a quiz recitation once its answer was graded 48 h ago.
A recording still waiting for its teacher is never deleted. Scores, feedback text and timed notes stay; only the
audio goes. The metadata row is kept, marked deleted, so history and the restore drill still see the submission.
Run hourly from run_scheduled. `--dry-run` only counts."""
from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db.models import Exists, OuterRef, Q
from django.utils import timezone

from apps.assessments.models import Answer
from apps.learning.models import Submission
from apps.media.models import MediaObject
from apps.media.storage import get_storage


def due_recordings(hours: int):
    cutoff = timezone.now() - timedelta(hours=hours)
    reviewed = Submission.objects.filter(media=OuterRef("pk"), feedback__created_at__lt=cutoff)
    graded = Answer.objects.filter(recording=OuterRef("pk"), graded_at__lt=cutoff)
    # Never delete audio that another submission or answer still waits on (defensive: uploads are single-use).
    waiting = Q(Exists(Submission.objects.filter(media=OuterRef("pk"), feedback__isnull=True))) | Q(
        Exists(Answer.objects.filter(recording=OuterRef("pk"), graded_at__isnull=True)))
    return (MediaObject.objects.filter(purpose=MediaObject.Purpose.RECITATION).exclude(state=MediaObject.State.DELETED)
            .filter(Q(Exists(reviewed)) | Q(Exists(graded))).exclude(waiting))


class Command(BaseCommand):
    help = "Delete student recordings 48 hours after the teacher's review."

    def add_arguments(self, parser):
        parser.add_argument("--hours", type=int, default=settings.RECORDING_RETENTION_HOURS)
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, hours, dry_run, **opts):
        n = 0
        for m in due_recordings(hours).iterator():
            n += 1
            if dry_run:
                continue
            get_storage().delete(m.key)
            m.state = MediaObject.State.DELETED
            m.save(update_fields=["state", "updated_at"])
        self.stdout.write(self.style.SUCCESS(f"{'Would delete' if dry_run else 'Deleted'} {n} reviewed recording(s)."))
