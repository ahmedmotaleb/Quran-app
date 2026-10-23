"""PROMPT 46: academy KPIs and teacher workload. Numbers are aggregated on the server, each comes with its definition,
empty ratios are null (not 0%), and only admins with analytics.view (and exports.create for CSV) can read them."""
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.accounts.models import Role
from apps.core.audit import audit
from apps.core.models import AuditEvent
from apps.learning.models import Assignment, Correction, Feedback, Submission
from apps.media.models import MediaObject
from apps.scheduling.models import Booking, BookingExcuse, Circle, CircleMember

from .conftest import client_for, make_user, occurrence
from .test_admins import staff

pytestmark = pytest.mark.django_db
KPI, WL = "/api/v1/admin/kpis", "/api/v1/admin/teacher-workload"


def book(occ, student, att="", key=None):
    return Booking.objects.create(occurrence=occ, student=student, idempotency_key=key or f"{occ.pk}-{student.pk}", attendance=att)


def submit(teacher, student, *, hours_ago, reviewed_after=None):
    a = Assignment.objects.create(student=student, teacher=teacher, kind="hifz", title="مهمة", surah=67, ayah_from=1, ayah_to=5,
                                  due_at=timezone.now() + timedelta(days=1), status="submitted")
    m = MediaObject.objects.create(owner=student, purpose="recitation", key=f"rec/{a.pk}.webm", content_type="audio/webm")
    s = Submission.objects.create(assignment=a, student=student, media=m, attempt=1, duration_seconds=30, idempotency_key=f"k{a.pk}")
    Submission.objects.filter(pk=s.pk).update(created_at=timezone.now() - timedelta(hours=hours_ago))
    if reviewed_after is not None:
        f = Feedback.objects.create(submission=s, teacher=teacher, score_hifz=5, score_tajweed=5, score_fluency=5, decision="accept")
        Feedback.objects.filter(pk=f.pk).update(created_at=timezone.now() - timedelta(hours=hours_ago - reviewed_after))
    return s


@pytest.fixture
def data(world):
    s3 = make_user("s3@x.test")
    past = [occurrence(world.t1, in_hours=-24 * d, capacity=2) for d in (1, 2, 3)]
    book(past[0], world.s1, "present"); book(past[0], world.s2, "late")
    book(past[1], world.s1, "absent")  # unexcused
    b = book(past[1], s3, "absent")
    BookingExcuse.objects.create(booking=b, student=s3, reason="x", status="approved")  # absent but excused-approved
    book(past[2], world.s1)  # attendance not marked yet
    book(occurrence(world.t2, in_hours=-30), world.s2, "absent")
    soon = occurrence(world.t1, in_hours=20, capacity=2)
    book(soon, world.s1)
    occurrence(world.t1, in_hours=30)  # empty, free slot
    submit(world.t1, world.s1, hours_ago=10, reviewed_after=4)
    submit(world.t1, world.s1, hours_ago=20, reviewed_after=8)
    submit(world.t1, world.s1, hours_ago=60)  # overdue (> 48 h)
    submit(world.t2, world.s2, hours_ago=5)
    Correction.objects.create(student=world.s1, teacher=world.t1, source="session", surah=1, ayah=1, category="madd")
    Correction.objects.create(student=world.s1, teacher=world.t1, source="session", surah=1, ayah=2, category="madd", status="corrected")
    audit("student.auto_suspended_absence", target=world.s1)
    return type("D", (), {"s3": s3, "soon": soon})


def test_kpi_definitions_and_numbers(world, data):
    r = client_for(world.admin).get(KPI).json()
    k = r["kpis"]
    att = k["attendance"]
    # present+late over present+late+absent; the unmarked booking does not count, it is reported separately.
    assert (att["present"], att["late"], att["absent"], att["unmarked"]) == (1, 1, 3, 1)
    assert att["attendance_rate"] == {"value": 0.4, "num": 2, "den": 5}
    # unexcused = absent without approved/pending excuse (s1 for t1, s2 for t2) over marked bookings.
    assert att["unexcused_absence_rate"]["num"] == 2 and att["unexcused_absence_rate"]["den"] == 5
    assert k["review_turnaround_hours"] == {"median": 6.0, "reviews": 2}
    assert k["recording_review_backlog"]["count"] == 2 and k["recording_review_backlog"]["oldest_hours"] >= 59.9
    assert k["suspended_by_absence"] == 1 and k["active_students"] == 3 and k["active_teachers"] == 2
    assert k["pending_teacher_approvals"] == 0 and k["new_registrations"] == 3
    assert set(r["definitions"]) >= {"attendance_rate", "booking_fill_rate", "review_turnaround_hours", "overdue_feedback"}
    assert r["range"]["timezone"] == "Africa/Cairo" and r["not_filtered"] == {}


def test_filters_and_empty_ratios_are_null(world, data):
    c = client_for(world.admin)
    k = c.get(KPI, {"teacher": world.t2.pk}).json()
    assert k["kpis"]["attendance"]["attendance_rate"] == {"value": 0.0, "num": 0, "den": 1}
    assert k["kpis"]["recording_review_backlog"]["count"] == 1 and "new_registrations" in k["not_filtered"]["teacher"]
    old = c.get(KPI, {"from": "2020-01-01", "to": "2020-01-31"}).json()["kpis"]
    assert old["attendance"]["attendance_rate"]["value"] is None and old["booking_fill_rate"]["value"] is None
    assert old["review_turnaround_hours"]["median"] is None
    circle = Circle.objects.create(name="حلقة", teacher=world.t1, capacity=4, state="published")
    CircleMember.objects.create(circle=circle, student=world.s1)
    k = c.get(KPI, {"circle": circle.pk}).json()
    assert k["kpis"]["circle_capacity_utilization"] == {"value": 0.25, "num": 1, "den": 4} and "assignment_completion" in k["not_filtered"]["circle"]
    assert c.get(KPI, {"from": "2026-02-01", "to": "2026-01-01"}).status_code == 400
    assert c.get(KPI, {"from": "nope"}).status_code == 400
    assert c.get(KPI, {"from": "2024-01-01", "to": "2026-01-01"}).status_code == 400  # more than a year


def test_teacher_workload(world, data):
    rows = {r["teacher"]["id"]: r for r in client_for(world.admin).get(WL).json()["results"]}
    t1 = rows[world.t1.pk]
    assert t1["active_students"] == 1 and t1["awaiting_review"] == 1 and t1["overdue_feedback"] == 1
    assert t1["unresolved_mistakes"] == 1 and t1["upcoming_sessions"] == 1 and t1["available_slots"] == 2
    assert t1["attendance_rate"]["value"] == 0.5 and t1["no_show_rate"] == {"value": 0.5, "num": 2, "den": 4}
    assert t1["utilization"] == {"value": 0.833, "num": 5, "den": 6}  # past sessions in the range only (3 × 2 seats)
    assert rows[world.t2.pk]["awaiting_review"] == 1 and rows[world.t2.pk]["overdue_feedback"] == 0
    BookingExcuse.objects.create(booking=Booking.objects.get(occurrence=data.soon), student=world.s1, status="pending")
    only = client_for(world.admin).get(WL, {"teacher": world.t1.pk}).json()["results"]
    assert len(only) == 1 and only[0]["pending_excuses"] == 1


def test_permissions_and_csv_export(world, data):
    assert client_for(world.t1).get(KPI).status_code == 403
    assert client_for(world.s1).get(WL).status_code == 403
    viewer = staff("viewer@x.test", perms=["analytics.view"])
    assert client_for(viewer).get(KPI).status_code == 200 and client_for(viewer).get(WL).status_code == 200
    assert client_for(viewer).post(WL + "/export", {}, format="json").status_code == 403  # no exports.create
    nobody = staff("nobody@x.test", perms=["users.view"])
    assert client_for(nobody).get(KPI).status_code == 403 and client_for(nobody).get(WL).status_code == 403
    exporter = staff("exp@x.test", perms=["analytics.view", "exports.create"])
    r = client_for(exporter).post(WL + "/export", {"teacher": world.t1.pk, "from": None}, format="json")
    assert r.status_code == 200 and r["Content-Type"].startswith("text/csv")
    body = r.content.decode("utf-8")
    assert body.startswith("﻿المعلم,") and world.t1.full_name in body and "50%" in body
    assert world.t2.full_name not in body and world.s1.email not in body  # teacher-level numbers only
    assert AuditEvent.objects.filter(action="admin.export", actor=exporter).exists()


def test_new_teacher_waiting_for_approval_counts(world):
    t = make_user("new-t@x.test", Role.TEACHER)
    t.teacher_profile.approved_at = None
    t.teacher_profile.save()
    k = client_for(world.admin).get(KPI).json()["kpis"]
    assert k["pending_teacher_approvals"] == 1 and k["active_teachers"] == 2
