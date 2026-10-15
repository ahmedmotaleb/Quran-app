"""Create due spaced-repetition review tasks for every student (idempotent). Also happens on demand when tasks are
listed; run this from a scheduler (e.g. Cloud Scheduler → Ops workflow) to have tasks ready before anyone looks."""
from django.core.management.base import BaseCommand

from apps.accounts.models import User
from apps.learning.models import ReviewSchedule
from apps.learning.reviews import ensure_due


class Command(BaseCommand):
    help = "Generate due review tasks (safe to run repeatedly)."

    def handle(self, **_):
        made = 0
        for st in User.objects.filter(pk__in=ReviewSchedule.objects.filter(active=True).values("student_id")):
            made += ensure_due(st)
        self.stdout.write(self.style.SUCCESS(f"Review tasks created: {made}"))
