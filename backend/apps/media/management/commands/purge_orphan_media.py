"""Deletes recordings that were uploaded but never submitted (default: older than 48 hours).
Run daily from the scheduler. `--dry-run` lists what would be deleted."""
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.db.models import Exists, OuterRef
from django.utils import timezone

from apps.learning.models import Feedback, Submission
from apps.media.models import MediaObject
from apps.media.storage import get_storage


class Command(BaseCommand):
    help = "Delete private uploads that were never attached to a submission or feedback."

    def add_arguments(self, parser):
        parser.add_argument("--hours", type=int, default=48)
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, hours, dry_run, **opts):
        cutoff = timezone.now() - timedelta(hours=hours)
        qs = (MediaObject.objects.filter(created_at__lt=cutoff, purpose__in=MediaObject.PRIVATE_PURPOSES)
              .exclude(state=MediaObject.State.DELETED)
              .annotate(sub=Exists(Submission.objects.filter(media=OuterRef("pk"))), fb=Exists(Feedback.objects.filter(voice=OuterRef("pk"))))
              .filter(sub=False, fb=False))
        n = 0
        for m in qs.iterator():
            n += 1
            if dry_run:
                self.stdout.write(f"would delete {m.key}")
                continue
            get_storage().delete(m.key)
            m.state = MediaObject.State.DELETED
            m.save(update_fields=["state", "updated_at"])
        self.stdout.write(self.style.SUCCESS(f"{'Would delete' if dry_run else 'Deleted'} {n} orphan upload(s)."))
