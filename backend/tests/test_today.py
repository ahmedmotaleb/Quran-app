"""Pack prompt 16: deterministic, server-backed daily plan."""
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.learning.models import ReviewSchedule
from apps.learning.reviews import _today
from apps.scheduling.models import Booking

from .conftest import client_for, occurrence
from .test_media_submissions import _private_root, submit, upload  # noqa: F401
from .test_progress import review, task

pytestmark = pytest.mark.django_db


def plan(w):
    return client_for(w.s1).get("/api/v1/today").json()


def test_priorities_and_determinism(world):
    late = task(world, kind="hifz", due_in=-timedelta(days=2))
    late_rev = task(world, kind="review", due_in=-timedelta(days=1))
    hours_left = (timezone.localtime(timezone.now(), timezone=__import__("zoneinfo").ZoneInfo(world.s1.timezone)).replace(hour=23, minute=0)
                  - timezone.now())
    due_today = task(world, kind="tajweed", due_in=max(hours_left, timedelta(minutes=5)) if hours_left.total_seconds() > 300 else timedelta(minutes=1))
    later = task(world, kind="hifz", due_in=timedelta(days=5))
    p1, p2 = plan(world), plan(world)
    assert p1 == p2  # same plan on refresh
    refs = [i["ref"] for i in p1["items"] if i["state"] == "todo"]
    assert refs.index(late_rev.id) < refs.index(late.id)  # overdue: review first
    assert refs.index(late.id) < refs.index(due_today.id)
    assert later.id not in refs  # not due and not needs-repeat: not in today's plan
    assert p1["counts"]["overdue"] == 2 and p1["rules"]
    assert all(i["est_minutes"] is None for i in p1["items"] if i["kind"] in ("hifz", "review", "tajweed"))  # no invented estimates


def test_completion_stays_visible_once_and_due_review_appears(world):
    t = task(world, due_in=timedelta(hours=1))
    review(world, t, "accept")  # accepted today → shows once as done
    p = plan(world)
    done = [i for i in p["items"] if i["ref"] == t.id]
    assert len(done) == 1 and done[0]["state"] == "done"
    sch = ReviewSchedule.objects.get(source=t)
    ReviewSchedule.objects.filter(pk=sch.pk).update(next_due=_today(world.s1))
    p = plan(world)
    rev = [i for i in p["items"] if i["kind"] == "review" and i["state"] == "todo"]
    assert len(rev) == 1 and rev[0]["priority"] == 2
    assert len([i for i in plan(world)["items"] if i["kind"] == "review" and i["state"] == "todo"]) == 1  # not duplicated


def test_today_session_and_scoping(world):
    o = occurrence(world.t1, in_hours=1)
    if o.starts_at.astimezone(__import__("zoneinfo").ZoneInfo(world.s1.timezone)).date() == _today(world.s1):
        Booking.objects.create(occurrence=o, student=world.s1, idempotency_key="k")
        s = [i for i in plan(world)["items"] if i["kind"] == "session"]
        assert len(s) == 1 and s[0]["est_minutes"] == 45
    assert client_for(world.t1).get("/api/v1/today").status_code == 403
    assert client_for(world.p1).get("/api/v1/today").status_code == 403
