"""Pack prompt 15: spaced-repetition review engine."""
from datetime import timedelta

import pytest

from apps.learning.models import Assignment, ReviewEvent, ReviewSchedule
from apps.learning.reviews import _today, ensure_due

from .conftest import PW, client_for
from .test_media_submissions import FB, _private_root, submit, upload  # noqa: F401
from .test_progress import task

pytestmark = pytest.mark.django_db


def feedback(w, t, decision="accept", scores=(5, 5, 5)):
    s1 = client_for(w.s1)
    sub = submit(s1, t, upload(s1).json()["id"]).json()
    body = {**FB, "score_hifz": scores[0], "score_tajweed": scores[1], "score_fluency": scores[2], "decision": decision}
    if decision == "repeat":
        body["needs_review"] = "الآيات 2–4"
    r = client_for(w.t1).post(f"/api/v1/submissions/{sub['id']}/feedback", body, format="json")
    assert r.status_code == 201, r.json()


def make_due(sch):
    ReviewSchedule.objects.filter(pk=sch.pk).update(next_due=_today(sch.student))
    sch.refresh_from_db()


def review_tasks(w):
    return list(Assignment.objects.filter(student=w.s1, review_schedule__isnull=False).order_by("review_cycle"))


def test_full_cycle_accept_due_success_repeat_override_and_missed_day(world):
    src = task(world, a=1, b=5)
    feedback(world, src, "accept")
    sch = ReviewSchedule.objects.get(source=src)
    today = _today(world.s1)
    assert sch.step == 0 and sch.next_due == today + timedelta(days=1)
    src.refresh_from_db()
    assert src.next_review_on == sch.next_due

    # Not due yet: listing tasks creates nothing.
    client_for(world.s1).get("/api/v1/assignments")
    assert review_tasks(world) == []

    # Due: exactly one task, however often it is requested.
    make_due(sch)
    for _ in range(3):
        client_for(world.s1).get("/api/v1/assignments")
    assert ensure_due(world.s1) == 0
    [r1] = review_tasks(world)
    assert r1.kind == "review" and (r1.surah, r1.ayah_from, r1.ayah_to) == (67, 1, 5) and r1.review_cycle == 1

    # Strong review → next interval (3 days).
    feedback(world, r1, "accept", (5, 4, 4))
    sch.refresh_from_db()
    assert sch.step == 1 and sch.next_due == today + timedelta(days=3)

    # Second review: needs-repeat, then accepted → one interval back (earlier review).
    make_due(sch)
    ensure_due(world.s1)
    r2 = review_tasks(world)[-1]
    assert r2.review_cycle == 2
    feedback(world, r2, "repeat", (3, 3, 3))
    sch.refresh_from_db()
    assert sch.step == 1  # waits for the final decision
    feedback(world, r2, "accept", (4, 4, 4))
    sch.refresh_from_db()
    assert sch.step == 0 and sch.next_due == today + timedelta(days=1)

    # Average result (lowest score 3) → same interval.
    make_due(sch)
    ensure_due(world.s1)
    feedback(world, review_tasks(world)[-1], "accept", (4, 3, 5))
    sch.refresh_from_db()
    assert sch.step == 0

    # Missed day: the open review stays (overdue); no second task is generated for the same range.
    make_due(sch)
    ensure_due(world.s1)
    open_task = review_tasks(world)[-1]
    Assignment.objects.filter(pk=open_task.pk).update(due_at=open_task.due_at - timedelta(days=4))
    ReviewSchedule.objects.filter(pk=sch.pk).update(next_due=today - timedelta(days=4))
    assert ensure_due(world.s1) == 0
    assert client_for(world.s1).get("/api/v1/progress/me").json()["review"]["overdue"] == 1

    # Teacher override moves the open task too, with a reason; history is complete.
    nd = (today + timedelta(days=2)).isoformat()
    t1 = client_for(world.t1)
    assert t1.patch(f"/api/v1/teacher/review-schedules/{sch.pk}", {"next_due": nd}, format="json").status_code == 400  # reason
    r = t1.patch(f"/api/v1/teacher/review-schedules/{sch.pk}", {"next_due": nd, "reason": "سفر الطالب"}, format="json").json()
    assert r["next_due"] == nd
    open_task.refresh_from_db()
    assert open_task.due_at.astimezone(__import__("zoneinfo").ZoneInfo(world.s1.timezone)).date().isoformat() == nd
    kinds = [e.kind for e in ReviewEvent.objects.filter(schedule=sch)]
    assert kinds[0] == "scheduled" and "repeat" in kinds and kinds.count("completed") == 3 and kinds[-1] == "override"
    hist = t1.get(f"/api/v1/teacher/students/{world.s1.id}/review-schedules").json()
    assert hist["help"] and hist["results"][0]["history"][-1]["reason"] == "سفر الطالب"


def test_pause_resume_and_scoping(world):
    src = task(world)
    feedback(world, src, "accept")
    sch = ReviewSchedule.objects.get(source=src)
    t1 = client_for(world.t1)
    assert t1.patch(f"/api/v1/teacher/review-schedules/{sch.pk}", {"active": False, "reason": "إجازة"}, format="json").json()["active"] is False
    make_due(sch)
    assert ensure_due(world.s1) == 0  # paused: nothing generated
    assert t1.patch(f"/api/v1/teacher/review-schedules/{sch.pk}", {"active": True, "reason": "عودة"}, format="json").json()["active"] is True
    assert ensure_due(world.s1) == 1
    # Another teacher and other roles cannot see or change it.
    assert client_for(world.t2).patch(f"/api/v1/teacher/review-schedules/{sch.pk}", {"active": False, "reason": "x y z"}, format="json").status_code == 404
    assert client_for(world.t2).get(f"/api/v1/teacher/students/{world.s1.id}/review-schedules").status_code == 404
    assert client_for(world.s1).patch(f"/api/v1/teacher/review-schedules/{sch.pk}", {}, format="json").status_code == 403
    mine = client_for(world.s1).get("/api/v1/review-schedules").json()
    assert len(mine["results"]) == 1 and "history" not in mine["results"][0]


def test_only_accepted_memorization_is_scheduled(world):
    src = task(world)
    feedback(world, src, "repeat", (2, 2, 2))
    assert not ReviewSchedule.objects.exists()
    rev = task(world, kind="review")
    feedback(world, rev, "accept")
    assert not ReviewSchedule.objects.exists()  # a manual review task does not start a schedule


def test_intervals_are_an_admin_setting(world):
    c = client_for(world.admin)
    assert c.patch("/api/v1/admin/settings", {"review_intervals": [3, 2]}, format="json").status_code == 400
    assert c.patch("/api/v1/admin/settings", {"review_intervals": [2, 5, 10]}, format="json").json()["review_intervals"] == [2, 5, 10]
    src = task(world)
    feedback(world, src, "accept")
    assert ReviewSchedule.objects.get(source=src).next_due == _today(world.s1) + timedelta(days=2)
    assert PW
