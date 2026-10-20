"""Pack prompt 34: the parent journey on the shared sign-in (no separate auth system).

Admin creates the parent → one-time setup link → parent signs in (role decided by the server) → linked children
only, never another family's child or a recording → logout ends the session; suspended/archived parents are refused.
"""
from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.learning.models import Assignment, Submission
from apps.media.models import MediaObject

from .conftest import PW, client_for, make_user

pytestmark = pytest.mark.django_db
A = "/api/v1/admin"


def _setup(link: str) -> dict:
    return dict(x.split("=", 1) for x in link.split("?", 1)[1].split("&"))


def web_login(email, password=PW):
    c = APIClient(enforce_csrf_checks=False)
    r = c.post("/api/v1/auth/login", {"email": email, "password": password, "client": "web"}, format="json")
    return c, r


def test_admin_creates_parent_links_children_and_parent_signs_in(world, settings):
    admin = client_for(world.admin)
    r = admin.post(f"{A}/users", {"full_name": "ولي أمر جديد", "email": "dad@x.test", "role": "parent"}, format="json")
    assert r.status_code == 201
    pid, link = r.json()["id"], r.json()["setup_link"]
    for s in (world.s1, world.s2):  # a parent with two children
        assert admin.post(f"{A}/guardian-links", {"guardian": pid, "student": s.id}, format="json").status_code == 201
    q = _setup(link)
    anon = APIClient()
    assert anon.post("/api/v1/auth/password/reset", {**q, "password": PW}, format="json").status_code == 200
    assert anon.post("/api/v1/auth/password/reset", {**q, "password": PW + "y"}, format="json").status_code == 400  # one-time
    c, r = web_login("dad@x.test")
    assert r.status_code == 200 and r.json()["user"]["role"] == "parent"
    assert c.get("/api/v1/me").json()["role"] == "parent"
    kids = {k["id"] for k in c.get("/api/v1/parent/children").json()["results"]}
    assert kids == {world.s1.id, world.s2.id}
    # A role sent by the client changes nothing.
    _, r2 = web_login("dad@x.test")
    assert r2.json()["user"]["role"] == "parent"
    assert APIClient().post("/api/v1/auth/login", {"email": "dad@x.test", "password": PW, "role": "student"},
                            format="json").json()["user"]["role"] == "parent"


def test_unlinked_child_and_tampered_ids_are_refused(world):
    p = client_for(world.p1)  # linked to s1 only
    assert p.get(f"/api/v1/parent/children/{world.s1.id}/progress").status_code == 200
    assert p.get(f"/api/v1/parent/children/{world.s2.id}/progress").status_code in (403, 404)
    assert p.get(f"/api/v1/corrections/summary?student={world.s2.id}").status_code == 404
    assert p.get(f"/api/v1/corrections?student={world.s2.id}").json()["count"] == 0
    assert all(k["id"] == world.s1.id for k in p.get("/api/v1/parent/children").json()["results"])


def test_parent_never_gets_a_recording(world):
    a = Assignment.objects.create(student=world.s1, teacher=world.t1, kind="hifz", title="حفظ", surah=67, ayah_from=1, ayah_to=5,
                                  due_at=timezone.now() + timedelta(days=1))
    m = MediaObject.objects.create(owner=world.s1, purpose="recitation", key="rec/p.webm", content_type="audio/webm", state="ready")
    s = Submission.objects.create(assignment=a, student=world.s1, media=m, attempt=1, duration_seconds=20, idempotency_key="pk1")
    rows = client_for(world.p1).get("/api/v1/submissions").json()["results"]
    assert [x["id"] for x in rows] == [s.id] and rows[0]["audio"] is None
    assert client_for(world.p1).get(f"/api/v1/media/{m.id}/url").status_code in (403, 404)


@pytest.mark.parametrize("status", ["suspended", "archived"])
def test_suspended_or_archived_parent_is_refused(world, status):
    admin = client_for(world.admin)
    assert admin.post(f"{A}/users/{world.p1.id}/status", {"status": status, "reason": "طلب الأسرة"}, format="json").status_code == 200
    _, r = web_login(world.p1.email)
    assert r.status_code in (400, 401, 403) and "user" not in r.json()
    assert APIClient().post("/api/v1/auth/password/forgot", {"email": world.p1.email}, format="json").status_code == 200  # generic


def test_logout_ends_the_parent_session(world):
    c, r = web_login(world.p1.email)
    assert r.status_code == 200 and c.get("/api/v1/me").status_code == 200
    csrf = c.get("/api/v1/auth/csrf").json().get("csrf_token") or c.cookies.get("csrftoken").value
    assert c.post("/api/v1/auth/logout", HTTP_X_CSRFTOKEN=csrf).status_code in (200, 204)
    assert c.get("/api/v1/me").status_code in (401, 403)


def test_parent_has_no_teacher_or_student_actions(world):
    p = client_for(world.p1)
    body = {"student": world.s1.id, "kind": "hifz", "title": "حفظ", "surah": 1, "ayah_from": 1, "ayah_to": 7,
            "due_at": (timezone.now() + timedelta(days=1)).isoformat()}
    assert p.post("/api/v1/assignments", body, format="json").status_code == 403
    assert p.post("/api/v1/corrections", {"student": world.s1.id}, format="json").status_code == 403
    assert p.get("/api/v1/teacher/dashboard").status_code == 403
    assert make_user("other-parent@x.test", role="parent") and \
        client_for(world.p1).get("/api/v1/parent/children").json()["count"] == 1
