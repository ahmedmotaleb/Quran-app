"""Pack prompt 11: one progress calculation, consistent across student, teacher, parent and admin views."""
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.learning.models import Assignment, LessonCompletion
from apps.scheduling.models import Booking

from .conftest import client_for, make_user, occurrence
from .test_media_submissions import FB, _private_root, submit, upload  # noqa: F401 (fixture re-export)

pytestmark = pytest.mark.django_db


def task(w, kind="hifz", surah=67, a=1, b=10, due_in=timedelta(days=1), student=None):
    return Assignment.objects.create(student=student or w.s1, teacher=w.t1, kind=kind, title=f"{kind} {surah}:{a}-{b}", surah=surah,
                                     ayah_from=a, ayah_to=b, due_at=timezone.now() + due_in, status="in_progress")


def review(w, t, decision="accept", scores=(4, 3, 5)):
    s1, t1 = client_for(w.s1), client_for(w.t1)
    sub = submit(s1, t, upload(s1, dur=90).json()["id"]).json()
    body = {**FB, "score_hifz": scores[0], "score_tajweed": scores[1], "score_fluency": scores[2], "decision": decision}
    if decision == "repeat":
        body["needs_review"] = "الآيات 3–5"
    assert t1.post(f"/api/v1/submissions/{sub['id']}/feedback", body, format="json").status_code == 201


def test_memorization_counts_distinct_ayahs_once(world):
    a1 = task(world, a=1, b=10)          # 10 ayahs
    a2 = task(world, a=5, b=14)          # overlaps 5–10 → only 4 new ayahs
    task(world, surah=1, a=1, b=7)       # 7 ayahs, never accepted
    review(world, a1, "repeat")          # needs-repeat cycle …
    review(world, a1, "accept")          # … then accepted on the second attempt
    review(world, a2, "accept")
    p = client_for(world.s1).get("/api/v1/progress/me").json()
    m = p["memorization"]
    assert m["assigned_ayahs"] == 14 + 7 and m["accepted_ayahs"] == 14  # repeats never inflate the count
    assert m["pct"] == round(100 * 14 / 21, 1)
    assert p["practice"]["submissions"] == 3 and p["practice"]["reviewed"] == 3 and p["practice"]["minutes"] == 4.5
    assert p["scores"]["needs_repeat"] == 1 and len(p["scores"]["points"]) == 3
    assert p["latest_feedback"]["decision"] == "accept"


def test_review_due_overdue_completed(world):
    task(world, kind="review", due_in=timedelta(days=5))  # future: neither due today nor overdue
    late = task(world, kind="review", due_in=-timedelta(days=3))
    done = task(world, kind="review", due_in=-timedelta(days=1))
    review(world, done, "accept")
    p = client_for(world.s1).get("/api/v1/progress/me").json()["review"]
    assert p["overdue"] == 1 and p["completed"] == 1 and p["due_today"] == 0
    late.refresh_from_db()
    assert late.status == "in_progress"  # still open: counted as overdue, not dropped


def test_attendance_rate_denominator_rules(world):
    now = timezone.now()
    for i, att in enumerate(["present", "late", "absent", "excused", ""]):
        o = occurrence(world.t1, in_hours=-(i + 2) * 24)
        Booking.objects.create(occurrence=o, student=world.s1, idempotency_key=f"k{i}", attendance=att)
    future = occurrence(world.t1, in_hours=48)
    Booking.objects.create(occurrence=future, student=world.s1, idempotency_key="f")  # not held yet: not counted
    a = client_for(world.s1).get("/api/v1/progress/me").json()["attendance"]
    assert a["sessions"] == 5 and a["unmarked"] == 1 and a["excused"] == 1
    assert a["rate"] == round(2 / 3, 3)  # (present+late)/(present+late+absent)
    assert now


def test_same_numbers_for_student_teacher_parent_and_scoping(world):
    t = task(world)
    review(world, t, "accept")
    LessonCompletion.objects.create(student=world.s1, lesson=_lesson())
    mine = client_for(world.s1).get("/api/v1/progress/me").json()
    teacher = client_for(world.t1).get(f"/api/v1/teacher/students/{world.s1.id}/progress").json()
    parent = client_for(world.p1).get(f"/api/v1/parent/children/{world.s1.id}/progress").json()
    for view in (teacher, parent):
        for k in ("memorization", "review", "attendance", "practice", "learning", "assignments", "streak_days"):
            assert view[k] == mine[k], k
    assert mine["learning"]["lessons_completed"] == 1 and mine["streak_days"] == 1
    # Scoping: other teacher / unlinked parent / other student get 404 or 403.
    assert client_for(world.t2).get(f"/api/v1/teacher/students/{world.s1.id}/progress").status_code == 404
    p2 = make_user("p2@x.test", role="parent")
    assert client_for(p2).get(f"/api/v1/parent/children/{world.s1.id}/progress").status_code == 404
    assert client_for(world.s2).get(f"/api/v1/teacher/students/{world.s1.id}/progress").status_code == 403
    # Revoking the guardian link removes access immediately.
    world.link.status = "revoked"
    world.link.save()
    assert client_for(world.p1).get(f"/api/v1/parent/children/{world.s1.id}/progress").status_code == 404
    assert "audio" not in str(parent) and "url" not in str(parent)


def test_admin_summary_is_aggregate_only(world):
    review(world, task(world), "accept")
    r = client_for(world.admin).get("/api/v1/admin/progress").json()
    assert r["submissions"] == 1 and r["accepted"] == 1 and "student" not in r
    assert client_for(world.t1).get("/api/v1/admin/progress").status_code == 403


def test_date_range_and_timezone_bucketing(world):
    world.s1.timezone = "Asia/Tokyo"
    world.s1.save()
    t = task(world)
    review(world, t, "accept")
    today = timezone.now().astimezone(__import__("zoneinfo").ZoneInfo("Asia/Tokyo")).date()
    p = client_for(world.s1).get("/api/v1/progress/me", {"from": today.isoformat(), "to": today.isoformat()}).json()
    assert p["practice"]["submissions"] == 1 and p["scores"]["points"][0]["date"] == today.isoformat()
    old = client_for(world.s1).get("/api/v1/progress/me", {"from": "2020-01-01", "to": "2020-01-31"}).json()
    assert old["practice"]["submissions"] == 0 and old["memorization"]["accepted_ayahs"] == 10  # memorization is all-time
    assert client_for(world.s1).get("/api/v1/progress/me", {"from": "2020-02-01", "to": "2020-01-01"}).status_code == 400
    assert client_for(world.s1).get("/api/v1/progress/me", {"from": "nope"}).status_code == 400


def _lesson():
    from apps.learning.models import Course, Lesson

    t = make_user(f"t{timezone.now().timestamp()}@x.test", role="teacher")
    c = Course.objects.create(title="c", teacher=t, state="published")
    return Lesson.objects.create(course=c, title="l", body="b", state="published")


def test_teacher_dashboard_signals_are_scoped_and_explicit(world):
    t = task(world)
    s1 = client_for(world.s1)
    submit(s1, t, upload(s1).json()["id"])                      # awaiting review
    task(world, kind="review", due_in=-timedelta(days=2))        # overdue
    other = task(world, student=world.s2)                        # s2 is assigned to t2, not t1
    other.teacher = world.t2
    other.save()
    d = client_for(world.t1).get("/api/v1/teacher/dashboard").json()
    assert [x["student"]["id"] for x in d["awaiting_review"]] == [world.s1.id]
    assert d["awaiting_review"][0]["age_hours"] >= 0
    assert [x["student"]["id"] for x in d["overdue"]] == [world.s1.id] and d["overdue"][0]["days_late"] >= 1
    assert all(x["student"]["id"] != world.s2.id for x in d["awaiting_review"] + d["overdue"])
    assert "falling_scores" in d["rules"]
    assert client_for(world.s1).get("/api/v1/teacher/dashboard").status_code == 403


def test_repeated_needs_repeat_signal(world):
    t = task(world)
    review(world, t, "repeat")
    review(world, t, "repeat")
    d = client_for(world.t1).get("/api/v1/teacher/dashboard").json()
    assert d["repeated_needs_repeat"] == [{"student": {"id": world.s1.id, "name": world.s1.full_name}, "needs_repeat_30d": 2}]


def test_parent_weekly_summary_linked_children_only(world):
    review(world, task(world), "accept")
    w = client_for(world.p1).get("/api/v1/parent/weekly-summary").json()
    assert [c["child"]["id"] for c in w["children"]] == [world.s1.id]
    assert w["children"][0]["submissions"] == 1 and "audio" not in str(w)
    assert client_for(world.s1).get("/api/v1/parent/weekly-summary").status_code == 403
