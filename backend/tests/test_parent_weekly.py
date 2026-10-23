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


def test_report_content_for_several_children_without_private_details(world, settings):
    """Each linked child (not other students): reviews, excused/unexcused absences, mistake trend, upcoming sessions
    and next week's targets; no teacher comment text, no recording links."""
    from datetime import timedelta

    from django.utils import timezone

    from apps.accounts.models import GuardianLink, LinkStatus
    from apps.learning.models import Assignment, Correction
    from apps.learning.progress import weekly_summary
    from apps.scheduling.models import Booking, BookingExcuse

    from .conftest import client_for, make_user, occurrence

    kid2 = make_user("kid2@x.test")
    GuardianLink.objects.create(guardian=world.p1, student=kid2, status=LinkStatus.ACTIVE, approved_at=timezone.now())
    past1, past2 = occurrence(world.t1, in_hours=-30), occurrence(world.t1, in_hours=-54)
    b1 = Booking.objects.create(occurrence=past1, student=world.s1, idempotency_key="w1", attendance="absent")
    b2 = Booking.objects.create(occurrence=past2, student=world.s1, idempotency_key="w2", attendance="excused")
    BookingExcuse.objects.create(booking=b2, student=world.s1, reason="مرض شخصي خاص", status="approved")
    Booking.objects.create(occurrence=occurrence(world.t1, in_hours=50), student=world.s1, idempotency_key="w3")
    Assignment.objects.create(student=world.s1, teacher=world.t1, kind="hifz", title="حفظ سورة الملك", surah=67, ayah_from=1, ayah_to=5,
                              due_at=timezone.now() + timedelta(days=3))
    for i in range(3):
        Correction.objects.create(student=world.s1, teacher=world.t1, source="session", surah=67, ayah=i + 1, category="madd",
                                  internal_note="ملاحظة داخلية للمعلم")
    other = make_user("other-kid@x.test")  # not linked: never in the report
    Correction.objects.create(student=other, teacher=world.t1, source="session", surah=1, ayah=1, category="madd")
    r = client_for(world.p1).get("/api/v1/parent/weekly-summary").json()
    kids = {c["child"]["name"]: c for c in r["children"]}
    assert set(kids) == {world.s1.full_name, kid2.full_name}
    c = kids[world.s1.full_name]
    assert c["absences"] == {"excused_approved": 1, "unexcused": 1}
    assert c["mistakes"]["new_this_week"] == 3 and c["mistakes"]["top_categories"][0]["label"] == "المدود"
    assert len(c["upcoming_sessions"]) == 1 and c["targets"][0]["title"] == "حفظ سورة الملك"
    assert "reviews_completed" in c and "definitions" in r
    text = str(r)
    assert "ملاحظة داخلية" not in text and "مرض شخصي" not in text and "media" not in text and "recording" not in text
    assert client_for(world.s1).get("/api/v1/parent/weekly-summary").status_code == 403
    # Week = the last 7 days in the parent's time zone.
    world.p1.timezone = "Asia/Riyadh"
    world.p1.save()
    w = weekly_summary(world.p1)["week"]
    today = timezone.now().astimezone(ZoneInfo("Asia/Riyadh")).date()
    assert w == {"from": (today - timedelta(days=6)).isoformat(), "to": today.isoformat()}


def test_admin_chooses_day_hour_and_optional_email(world, settings):
    from django.core import mail

    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    from apps.accounts import emails

    real = emails.email_configured
    emails.email_configured = lambda: True
    try:
        s = AppSettings.load()
        s.parent_report_weekday, s.parent_report_hour, s.parent_report_email = 0, 9, True  # Monday 09:00
        s.save()
        assert "not due" in run(datetime(2026, 10, 23, 18, 5, tzinfo=CAIRO))  # Friday no longer
        assert "not due" in run(datetime(2026, 10, 26, 8, 30, tzinfo=CAIRO))
        assert "sent: 1" in run(datetime(2026, 10, 26, 9, 1, tzinfo=CAIRO))
        assert len(mail.outbox) == 1 and mail.outbox[0].to == [world.p1.email] and "ملخص الأسبوع" in mail.outbox[0].subject
        assert "sent: 0" in run(datetime(2026, 10, 26, 10, 1, tzinfo=CAIRO)) and len(mail.outbox) == 1  # once a week
    finally:
        emails.email_configured = real
