"""The «تقرير أولياء الأمور» setting now sends: a weekly in-app summary per parent, Friday evening Cairo time, once a week."""
from datetime import datetime
from io import StringIO
from unittest import mock
from zoneinfo import ZoneInfo

import pytest
from django.core.management import call_command

from apps.core.models import AppSettings
from apps.notifications.management.commands import parent_weekly_reports as cmd
from apps.notifications.models import Notification
from apps.notifications.push import payload_for

pytestmark = pytest.mark.django_db
CAIRO = ZoneInfo("Africa/Cairo")


def run(at: datetime, *args) -> str:
    out = StringIO()
    with mock.patch.object(cmd.timezone, "now", return_value=at):
        call_command("parent_weekly_reports", *args, stdout=out)
    return out.getvalue()


def test_sent_friday_evening_once_per_week_to_linked_parents_only(world):
    from .conftest import make_user

    lonely = make_user("lonely@x.test", "parent")  # no linked child
    assert "not due" in run(datetime(2026, 10, 23, 17, 0, tzinfo=CAIRO))  # Friday, before 18:00
    assert "not due" in run(datetime(2026, 10, 22, 20, 0, tzinfo=CAIRO))  # Thursday
    assert "sent: 1" in run(datetime(2026, 10, 23, 18, 5, tzinfo=CAIRO))
    assert "sent: 0" in run(datetime(2026, 10, 23, 19, 5, tzinfo=CAIRO))  # the next hourly run: no duplicate
    n = Notification.objects.get(kind="weekly_report")
    assert n.recipient == world.p1 and n.title == "ملخص الأسبوع لأبنائك" and n.body.startswith(world.s1.full_name + ":")
    assert "مهمة متأخرة" in n.body or "لا مهام متأخرة" in n.body
    assert not Notification.objects.filter(recipient=lonely).exists()
    assert "sent: 1" in run(datetime(2026, 10, 30, 18, 0, tzinfo=CAIRO))  # the following week
    # The phone's lock screen never shows the child's details.
    p = payload_for("weekly_report", "/")
    assert p["body"] == "ملخص الأسبوع لأبنائك جاهز." and world.s1.full_name not in str(p)


def test_setting_off_and_force(world):
    s = AppSettings.load()
    s.parent_weekly_report = False
    s.save()
    assert "off in settings" in run(datetime(2026, 10, 23, 18, 5, tzinfo=CAIRO), "--force")
    s.parent_weekly_report = True
    s.save()
    assert "sent: 1" in run(datetime(2026, 10, 21, 9, 0, tzinfo=CAIRO), "--force")


def test_parent_sees_it_in_the_inbox(world):
    from .conftest import client_for

    run(datetime(2026, 10, 23, 18, 5, tzinfo=CAIRO))
    items = client_for(world.p1).get("/api/v1/notifications").json()
    assert "ملخص الأسبوع لأبنائك" in str(items)
    assert "ملخص الأسبوع" not in str(client_for(world.s1).get("/api/v1/notifications").json())
