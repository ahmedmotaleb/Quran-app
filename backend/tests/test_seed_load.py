"""seed_load (load tests on an isolated runner or staging, PROMPT 47): refuses production and missing opt-in; a staging
re-run with --refresh adds slots and a fresh race slot instead of failing."""
from io import StringIO

import pytest
from django.core.management import CommandError, call_command

from apps.accounts.models import User
from apps.scheduling.models import SessionOccurrence

pytestmark = pytest.mark.django_db


def seed(*args) -> str:
    out = StringIO()
    call_command("seed_load", "--students", "4", "--teachers", "2", *args, stdout=out)
    return out.getvalue()


def test_guards(monkeypatch, settings):
    monkeypatch.delenv("LOAD_TEST_DATASET", raising=False)
    with pytest.raises(CommandError, match="LOAD_TEST_DATASET"):
        seed()
    monkeypatch.setenv("LOAD_TEST_DATASET", "1")
    settings.APP_ENV = "production"
    with pytest.raises(CommandError, match="non-production"):
        seed()
    assert not User.objects.filter(email__startswith="load-").exists()


def test_refresh_adds_a_new_race_slot(monkeypatch):
    monkeypatch.setenv("LOAD_TEST_DATASET", "1")
    first = seed()
    race1 = int(first.split("race_occurrence=")[1].split()[0])
    with pytest.raises(CommandError, match="already exists"):
        seed()
    again = seed("--refresh")
    race2 = int(again.split("race_occurrence=")[1].split()[0])
    assert again.startswith("refreshed:") and race2 != race1
    assert SessionOccurrence.objects.get(pk=race2).capacity == 1 and not SessionOccurrence.objects.get(pk=race2).bookings.exists()
    assert User.objects.filter(email__startswith="load-s").count() == 4  # no duplicate accounts
