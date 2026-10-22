from datetime import timedelta

import pytest
from django.core.management import call_command
from django.utils import timezone

from apps.accounts.models import AccountStatus, User

from .conftest import make_user

pytestmark = pytest.mark.django_db


def test_only_old_smoke_accounts_are_archived(world):
    old = make_user("smoke+1792675185568@example.com", full_name="اختبار النشر")
    new = make_user("smoke+1792675185999@example.com", full_name="اختبار النشر")
    lookalike = make_user("smoke+1@example.com", full_name="طالب حقيقي")
    User.objects.filter(pk__in=[old.pk, lookalike.pk]).update(date_joined=timezone.now() - timedelta(hours=2))
    call_command("archive_smoke_accounts")
    assert User.objects.get(pk=old.pk).status == AccountStatus.ARCHIVED
    assert User.objects.get(pk=new.pk).status == AccountStatus.ACTIVE      # a smoke test still running
    assert User.objects.get(pk=lookalike.pk).status == AccountStatus.ACTIVE
    assert world.s1.status == AccountStatus.ACTIVE
