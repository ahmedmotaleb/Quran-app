from datetime import datetime, timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import AuthToken, GuardianLink, LinkStatus, Role, StudentProfile, TeacherAssignment, TeacherProfile, User
from apps.scheduling.models import SessionOccurrence

PW = "correct-horse-battery-9"


def make_user(email, role=Role.STUDENT, **kw):
    u = User.objects.create_user(email, PW, full_name=kw.pop("full_name", email.split("@")[0]), role=role, **kw)
    if role == Role.STUDENT:
        StudentProfile.objects.create(user=u)
    if role == Role.TEACHER:
        TeacherProfile.objects.create(user=u, approved_at=timezone.now())
    return u


def client_for(user) -> APIClient:
    c = APIClient()
    _, raw = AuthToken.issue(user, device="test")
    c.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return c


@pytest.fixture
def world(db):
    """Two unrelated students, two teachers, one parent (linked to s1 only), one admin."""
    w = type("W", (), {})()
    w.s1, w.s2 = make_user("s1@x.test"), make_user("s2@x.test")
    w.t1, w.t2 = make_user("t1@x.test", Role.TEACHER), make_user("t2@x.test", Role.TEACHER)
    w.p1 = make_user("p1@x.test", Role.PARENT)
    w.admin = make_user("admin@x.test", Role.ADMIN, is_staff=True)
    TeacherAssignment.objects.create(teacher=w.t1, student=w.s1)
    TeacherAssignment.objects.create(teacher=w.t2, student=w.s2)
    w.link = GuardianLink.objects.create(guardian=w.p1, student=w.s1, status=LinkStatus.ACTIVE, approved_at=timezone.now())
    return w


def occurrence(teacher, *, in_hours=48, minutes=45, capacity=1, **kw):
    start = (timezone.now() + timedelta(hours=in_hours)).replace(microsecond=0)
    return SessionOccurrence.objects.create(teacher=teacher, starts_at=start, ends_at=start + timedelta(minutes=minutes), capacity=capacity, **kw)


@pytest.fixture(autouse=True)
def _clear_cache():
    """Rate-limit counters live in the cache; isolate tests from each other."""
    from django.core.cache import cache
    cache.clear()
    yield
