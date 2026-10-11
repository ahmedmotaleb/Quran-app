from datetime import date, time
from zoneinfo import ZoneInfo

import pytest

from apps.scheduling.models import AvailabilityException, AvailabilityRule, SessionOccurrence
from apps.scheduling.services import generate_occurrences


@pytest.mark.django_db
def test_generation_is_idempotent_and_respects_days_off(world):
    AvailabilityRule.objects.create(teacher=world.t1, weekday=6, start_time=time(16), end_time=time(18), timezone="Africa/Cairo",
                                    session_minutes=45, buffer_minutes=15, valid_from=date(2026, 10, 1))
    n = generate_occurrences(world.t1, start=date(2026, 10, 11), days=14)  # Sundays 11 and 18 Oct
    assert n == 4  # 16:00 and 17:00 each Sunday (18:00 would end after the window)
    assert generate_occurrences(world.t1, start=date(2026, 10, 11), days=14) == 0
    AvailabilityException.objects.create(teacher=world.t1, date=date(2026, 10, 25), kind="off")
    assert generate_occurrences(world.t1, start=date(2026, 10, 25), days=1) == 0


@pytest.mark.django_db
def test_cairo_wall_clock_survives_dst_change(world):
    # Egypt leaves summer time on the last Thursday of October 2026 (29 Oct): UTC+3 → UTC+2.
    AvailabilityRule.objects.create(teacher=world.t1, weekday=6, start_time=time(17), end_time=time(17, 45), timezone="Africa/Cairo",
                                    session_minutes=45, valid_from=date(2026, 10, 1))
    generate_occurrences(world.t1, start=date(2026, 10, 25), days=8)  # Sundays 25 Oct and 1 Nov
    cairo = ZoneInfo("Africa/Cairo")
    occ = list(SessionOccurrence.objects.filter(teacher=world.t1).order_by("starts_at"))
    assert [o.starts_at.astimezone(cairo).strftime("%H:%M") for o in occ] == ["17:00", "17:00"]
    assert [o.starts_at.astimezone(ZoneInfo("UTC")).hour for o in occ] == [14, 15]


@pytest.mark.django_db
def test_overnight_window(world):
    AvailabilityRule.objects.create(teacher=world.t2, weekday=5, start_time=time(23), end_time=time(1), timezone="Africa/Cairo",
                                    session_minutes=60, valid_from=date(2026, 10, 1))
    assert generate_occurrences(world.t2, start=date(2026, 10, 10), days=1) == 2  # 23:00 and 00:00
