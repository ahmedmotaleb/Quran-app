"""availability_report (Ops task availability-report): read-only, ids and counts only."""
import json
from io import StringIO

import pytest
from django.core.management import call_command

from apps.scheduling.models import AvailabilityRule

from .conftest import client_for, occurrence
from .test_availability import add, ahead

pytestmark = pytest.mark.django_db


def test_report_counts_ranges_hand_opened_and_bookable_times(world):
    d = ahead(3)
    add(client_for(world.t1), d.weekday(), "16:00", "18:00")      # t1: one range, changed through the API (audited)
    occurrence(world.t2, in_hours=72)                               # t2: no ranges, one session opened by hand
    out = StringIO()
    call_command("availability_report", stdout=out)
    data = json.loads(out.getvalue())
    by = {r["teacher"]: r for r in data["teachers"]}
    assert by[world.t1.pk]["ranges"] == 1 and by[world.t1.pk]["weekly_hours"] == 2.0 and by[world.t1.pk]["bookable_starts_7d"] == 6
    assert by[world.t1.pk]["last_changed"] is not None
    assert by[world.t2.pk]["ranges"] == 0 and by[world.t2.pk]["opened_by_hand"] == 1 and by[world.t2.pk]["last_changed"] is None
    s = data["summary"]
    assert s["approved_with_ranges"] == 1 and s["approved_without_ranges"] == 1 and s["without_ranges_but_opened_by_hand"] == 1
    assert world.t1.email not in out.getvalue() and world.t1.full_name not in out.getvalue()
    assert AvailabilityRule.objects.count() == 1                    # nothing changed
