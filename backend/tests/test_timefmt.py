"""12-hour Arabic times in messages, in the recipient's IANA zone (Cairo DST from the database, never a fixed offset);
a time-zone change keeps bookings (UTC instants) and reminder hours (local wall-clock) as they are."""
from datetime import datetime
from datetime import timezone as dt_timezone

import pytest

from apps.core.timefmt import clock, time_of, when
from apps.notifications.models import Notification, ReminderSettings
from apps.scheduling.models import Booking

from .conftest import client_for, occurrence

pytestmark = pytest.mark.django_db


def utc(s):
    return datetime.fromisoformat(s).replace(tzinfo=dt_timezone.utc)


def test_clock():
    assert clock(14, 30) == "٢:٣٠ مساءً"
    assert clock(9, 0) == "٩:٠٠ صباحًا"
    assert clock(0, 5) == "١٢:٠٥ صباحًا" and clock(12, 0) == "١٢:٠٠ مساءً" and clock(23, 59) == "١١:٥٩ مساءً"


def test_cairo_summer_and_winter_from_the_zone_database():
    assert time_of(utc("2026-06-10T11:30"), "Africa/Cairo") == "٢:٣٠ مساءً"     # UTC+3 in summer
    assert time_of(utc("2026-12-10T12:30"), "Africa/Cairo") == "٢:٣٠ مساءً"     # UTC+2 in winter
    assert when(utc("2026-11-08T12:30"), "Africa/Cairo") == "الأحد ٨ نوفمبر، ٢:٣٠ مساءً"
    assert time_of(utc("2026-11-08T12:30"), "America/New_York") == "٧:٣٠ صباحًا"  # a traveller's own zone
    assert time_of(utc("2026-11-08T12:30"), "Not/AZone") == "٢:٣٠ مساءً"         # unknown: academy time


def test_booking_message_uses_12_hour_local_time(world, django_capture_on_commit_callbacks):
    from apps.scheduling.services import book

    world.s1.timezone = "Asia/Riyadh"; world.s1.save(update_fields=["timezone"])
    occ = occurrence(world.t1)
    with django_capture_on_commit_callbacks(execute=True):
        book(student=world.s1, occurrence_id=occ.pk, idempotency_key="k1")
    n = Notification.objects.get(recipient=world.s1, kind="booking_confirmed")
    assert when(occ.starts_at, "Asia/Riyadh") in n.body
    assert ("صباحًا" in n.body or "مساءً" in n.body) and ":" in n.body
    assert not any(c.isascii() and c.isdigit() for c in n.body.split("·")[-1])  # no "2026-11-08 14:30"


def test_time_zone_change_keeps_bookings_and_reminder_hours(world):
    from apps.scheduling.services import book

    occ = occurrence(world.t1)
    b, _ = book(student=world.s1, occurrence_id=occ.pk, idempotency_key="k2")
    ReminderSettings.objects.create(user=world.s1, reading_hour=20, hifz_hour=17)
    before = Booking.objects.get(pk=b.pk).occurrence.starts_at
    c = client_for(world.s1)
    assert c.patch("/api/v1/me", {"timezone": "America/New_York"}, format="json").json()["timezone"] == "America/New_York"
    assert Booking.objects.get(pk=b.pk).occurrence.starts_at == before                 # the same instant (UTC)
    r = c.get("/api/v1/me/reminders").json()
    assert r["reading_hour"] == 20 and r["hifz_hour"] == 17 and r["timezone"] == "America/New_York"  # 8 PM where they are
    assert c.patch("/api/v1/me", {"timezone": "Mars/Base"}, format="json").status_code == 400
