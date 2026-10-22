"""Hourly: archive the student accounts the post-deploy smoke test signs up (smoke+<number>@example.com, named
«اختبار النشر»), so they do not pile up in the admin's student list. Archived, not deleted: nothing is lost, and they
stay findable under «مؤرشف»."""
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.accounts.models import AccountStatus, AuthToken, Role, User
from apps.core.audit import audit


class Command(BaseCommand):
    help = "Archive smoke-test student accounts older than 30 minutes."

    def handle(self, **_):
        qs = User.objects.filter(role=Role.STUDENT, email__regex=r"^smoke\+[0-9]+@example\.com$", full_name="اختبار النشر",
                                 date_joined__lt=timezone.now() - timedelta(minutes=30)).exclude(status=AccountStatus.ARCHIVED)
        ids = list(qs.values_list("pk", flat=True))
        if ids:
            User.objects.filter(pk__in=ids).update(status=AccountStatus.ARCHIVED)
            AuthToken.objects.filter(user_id__in=ids, revoked_at__isnull=True).update(revoked_at=timezone.now())
            audit("ops.smoke_accounts_archived", count=len(ids), ids=ids[:100])
        self.stdout.write(f"smoke accounts archived: {len(ids)}")
