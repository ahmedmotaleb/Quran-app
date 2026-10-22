"""The admin portal has its own session: on one device (one cookie jar) an admin and a student can both stay signed
in, each side only sees its own account, and CSRF still applies to the portal."""
import pytest
from rest_framework.test import APIClient

from apps.accounts.authentication import ADMIN_COOKIE

from .conftest import PW

pytestmark = pytest.mark.django_db
PORTAL = {"HTTP_X_HALQA_PORTAL": "admin"}


def csrf(c):
    return c.get("/api/v1/auth/csrf").json()["csrfToken"]


def test_admin_and_student_on_the_same_browser(world):
    c = APIClient(enforce_csrf_checks=True)
    assert c.post("/api/v1/auth/login", {"email": world.s1.email, "password": PW, "client": "web"}, format="json",
                  HTTP_X_CSRFTOKEN=csrf(c)).status_code == 200
    r = c.post("/api/v1/admin/auth/login", {"email": world.admin.email, "password": PW, "client": "web"}, format="json",
               HTTP_X_CSRFTOKEN=csrf(c), **PORTAL)
    assert r.status_code == 200 and ADMIN_COOKIE in r.cookies and r.cookies[ADMIN_COOKIE]["httponly"]
    assert c.get("/api/v1/me").json()["role"] == "student"            # the learner app keeps its account
    assert c.get("/api/v1/me", **PORTAL).json()["role"] == "admin"     # the portal has its own
    inv = c.post("/api/v1/invitations", {"purpose": "teacher_account", "email": "nt@x.test", "share_link": True}, format="json",
                 HTTP_X_CSRFTOKEN=csrf(c), **PORTAL)
    assert inv.status_code == 201
    assert c.post("/api/v1/invitations", {"purpose": "teacher_account", "email": "nt2@x.test"}, format="json",
                  HTTP_X_CSRFTOKEN=csrf(c)).status_code == 403          # as the student: refused
    # Portal sign-out leaves the student signed in.
    assert c.post("/api/v1/auth/logout", HTTP_X_CSRFTOKEN=csrf(c), **PORTAL).status_code == 204
    assert c.get("/api/v1/me", **PORTAL).status_code in (401, 403)
    assert c.get("/api/v1/me").json()["role"] == "student"


def test_portal_needs_csrf_and_its_own_cookie(world):
    c = APIClient(enforce_csrf_checks=True)
    c.post("/api/v1/admin/auth/login", {"email": world.admin.email, "password": PW, "client": "web"}, format="json",
           HTTP_X_CSRFTOKEN=csrf(c), **PORTAL)
    assert c.post("/api/v1/invitations", {"purpose": "teacher_account", "email": "a@x.test"}, format="json", **PORTAL).status_code == 403
    assert c.get("/api/v1/me").status_code in (401, 403)  # the admin cookie never signs in the learners' app


def test_password_change_ends_the_portal_session(world):
    c = APIClient()
    c.post("/api/v1/admin/auth/login", {"email": world.admin.email, "password": PW, "client": "web"}, format="json", **PORTAL)
    assert c.get("/api/v1/me", **PORTAL).status_code == 200
    world.admin.set_password(PW + "-new")
    world.admin.save()
    assert c.get("/api/v1/me", **PORTAL).status_code in (401, 403)
