"""Changing an id must never expose another learner's data (Prompt 05 acceptance)."""
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.learning.models import Assignment

from .conftest import client_for


def task(student, teacher, **kw):
    return Assignment.objects.create(student=student, teacher=teacher, kind="hifz", title="حفظ", surah=67, ayah_from=1, ayah_to=5,
                                     due_at=timezone.now() + timedelta(days=1), **kw)


@pytest.mark.django_db
class TestObjectAccess:
    def test_student_cannot_read_other_students_assignment(self, world):
        a2 = task(world.s2, world.t2)
        assert client_for(world.s1).get(f"/api/v1/assignments/{a2.pk}").status_code == 404
        assert client_for(world.s1).get("/api/v1/assignments").json()["count"] == 0
        assert client_for(world.s1).get(f"/api/v1/assignments?student={world.s2.pk}").json()["count"] == 0

    def test_teacher_sees_only_assigned_students(self, world):
        a1, a2 = task(world.s1, world.t1), task(world.s2, world.t2)
        c = client_for(world.t1)
        assert c.get(f"/api/v1/assignments/{a1.pk}").status_code == 200
        assert c.get(f"/api/v1/assignments/{a2.pk}").status_code == 404
        assert [s["id"] for s in c.get("/api/v1/teacher/students").json()["results"]] == [world.s1.pk]

    def test_teacher_cannot_assign_work_to_unassigned_student(self, world):
        body = {"student": world.s2.pk, "kind": "hifz", "title": "حفظ", "surah": 67, "ayah_from": 1, "ayah_to": 5,
                "due_at": (timezone.now() + timedelta(days=1)).isoformat()}
        assert client_for(world.t1).post("/api/v1/assignments", body, format="json").json()["code"] == "not_your_student"
        assert client_for(world.t2).post("/api/v1/assignments", body, format="json").status_code == 201

    def test_assignment_range_validated_against_quran(self, world):
        body = {"student": world.s1.pk, "kind": "hifz", "title": "حفظ", "surah": 67, "ayah_from": 1, "ayah_to": 31,
                "due_at": (timezone.now() + timedelta(days=1)).isoformat()}
        r = client_for(world.t1).post("/api/v1/assignments", body, format="json")
        assert r.status_code == 400 and r.json()["fields"]["ayah_to"] == ["السورة تحتوي 30 آية فقط."]

    def test_parent_sees_linked_child_only_and_loses_access_on_revoke(self, world):
        a1, a2 = task(world.s1, world.t1), task(world.s2, world.t2)
        c = client_for(world.p1)
        assert c.get(f"/api/v1/assignments/{a1.pk}").status_code == 200
        assert c.get(f"/api/v1/assignments/{a2.pk}").status_code == 404
        assert client_for(world.admin).post(f"/api/v1/admin/guardian-links/{world.link.pk}/revoke").status_code == 204
        assert c.get(f"/api/v1/assignments/{a1.pk}").status_code == 404
        assert c.get("/api/v1/parent/children").json()["count"] == 0

    def test_non_admins_cannot_call_admin_endpoints(self, world):
        for u in (world.s1, world.t1, world.p1):
            c = client_for(u)
            assert c.get("/api/v1/admin/users").status_code == 403
            assert c.post(f"/api/v1/admin/users/{world.s2.pk}/status", {"status": "suspended", "reason": "x"}).status_code == 403
            assert c.post("/api/v1/admin/guardian-links", {"guardian": world.p1.pk, "student": world.s2.pk}).status_code == 403

    def test_admin_cannot_suspend_other_admins_through_api(self, world):
        from .conftest import make_user
        from apps.accounts.models import Role
        other = make_user("admin2@x.test", Role.ADMIN)
        assert client_for(world.admin).post(f"/api/v1/admin/users/{other.pk}/status", {"status": "suspended", "reason": "x"}).status_code == 404
