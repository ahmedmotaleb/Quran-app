"""Creating tasks (PROMPT 43): teacher from a student file, a whole circle, and academic admins."""
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.accounts.models import AccountStatus, AdminProfile, Role, TeacherAssignment, User
from apps.accounts import admin_access as aa
from apps.learning.models import Assignment
from apps.notifications.models import Notification
from apps.scheduling.models import Circle, CircleMember

from .conftest import client_for, make_user

pytestmark = pytest.mark.django_db


def task(**kw):
    return {"kind": "hifz", "title": "حفظ سورة الملك", "surah": 67, "ayah_from": 1, "ayah_to": 5, "instructions": "",
            "due_at": (timezone.now() + timedelta(days=1)).isoformat(), "requires_recording": True, **kw}


def staff(email, preset):
    u = make_user(email, Role.ADMIN, owner=False)
    AdminProfile.objects.create(user=u, access_level="admin", preset=preset, permissions=sorted(aa.PRESETS[preset]))
    return client_for(u)


def test_teacher_creates_for_an_assigned_student_only_and_the_student_sees_it_at_once(world, django_capture_on_commit_callbacks):
    with django_capture_on_commit_callbacks(execute=True):
        r = client_for(world.t1).post("/api/v1/assignments", {**task(), "student": world.s1.pk}, format="json")
    assert r.status_code == 201 and r.json()["student"] == world.s1.pk and r.json()["teacher_name"] == world.t1.full_name
    mine = client_for(world.s1).get("/api/v1/assignments?kind=hifz").json()
    rows = mine["results"] if isinstance(mine, dict) else mine
    assert r.json()["id"] in [x["id"] for x in rows]
    assert Notification.objects.filter(recipient=world.s1, kind="assignment_new").exists()
    # Unrelated teacher (t2 is not linked to s1).
    r = client_for(world.t2).post("/api/v1/assignments", {**task(), "student": world.s1.pk}, format="json")
    assert r.status_code == 403 and r.json()["code"] == "not_your_student"


def test_academic_admin_allowed_support_and_read_only_denied(world):
    body = {**task(), "student": world.s1.pk}
    r = staff("acad@x.test", "academic_manager").post("/api/v1/admin/assignments", body, format="json")
    assert r.status_code == 201 and r.json()["teacher"] == world.t1.pk  # the only linked teacher
    assert Assignment.objects.get(pk=r.json()["id"]).teacher == world.t1
    for preset in ("support", "read_only"):
        r = staff(f"{preset}@x.test", preset).post("/api/v1/admin/assignments", body, format="json")
        assert r.status_code == 403 and r.json()["code"] == "admin_permission_denied", preset
    # The responsible teacher must be linked; a student without a teacher is refused.
    owner = client_for(world.admin)
    assert owner.post("/api/v1/admin/assignments", {**body, "teacher": world.t2.pk}, format="json").status_code == 400
    TeacherAssignment.objects.create(teacher=world.t2, student=world.s1)
    assert owner.post("/api/v1/admin/assignments", body, format="json").json()["fields"]["teacher"]  # two teachers: choose
    assert owner.post("/api/v1/admin/assignments", {**body, "teacher": world.t2.pk}, format="json").status_code == 201
    lone = make_user("lone@x.test")
    assert owner.post("/api/v1/admin/assignments", {**body, "student": lone.pk}, format="json").json()["code"] == "no_teacher"
    assert owner.post("/api/v1/admin/assignments", {**body, "ayah_to": 99}, format="json").status_code == 400  # Hafs range


def test_circle_batch_reaches_active_linked_members_only(world):
    c = Circle.objects.create(name="حلقة الفجر", teacher=world.t1, capacity=10, state="published")
    s3 = make_user("s3@x.test")
    gone = make_user("gone@x.test")
    off = make_user("off@x.test")
    for st in (world.s1, s3, off):
        TeacherAssignment.objects.get_or_create(teacher=world.t1, student=st)
    for st in (world.s1, world.s2, s3, gone, off):
        CircleMember.objects.create(circle=c, student=st, created_by=world.admin)
    CircleMember.objects.filter(circle=c, student=gone).update(active=False, ended_at=timezone.now())
    User.objects.filter(pk=off.pk).update(status=AccountStatus.SUSPENDED)
    teacher = client_for(world.t1)
    circles = teacher.get("/api/v1/teacher/circles").json()["results"]
    assert circles == [{"id": c.pk, "name": "حلقة الفجر", "state": "published", "members": 4, "reachable": 2}]
    r = teacher.post(f"/api/v1/circles/{c.pk}/assignments", task(title="مراجعة الأسبوع", kind="review"), format="json").json()
    assert (r["created"], r["skipped"]) == (2, 2)
    by = {x["student"]: x for x in r["results"]}
    assert gone.pk not in by  # ended membership: not a member
    assert by[off.pk]["outcome"] == "skipped" and by[world.s2.pk]["outcome"] == "skipped"
    assert set(Assignment.objects.filter(title="مراجعة الأسبوع").values_list("student_id", flat=True)) == {world.s1.pk, s3.pk}
    # Another teacher's circle, and invalid ranges, create nothing.
    assert client_for(world.t2).post(f"/api/v1/circles/{c.pk}/assignments", task(), format="json").status_code == 404
    assert teacher.post(f"/api/v1/circles/{c.pk}/assignments", task(ayah_to=99), format="json").status_code == 400
    assert Assignment.objects.filter(title="حفظ سورة الملك").count() == 0
