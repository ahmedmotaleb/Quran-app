"""Admin bulk actions, advanced filters, search, sort and pagination (select-all / bulk toolbar)."""
from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import AccountStatus, AuthToken, User
from apps.assessments.models import Attempt, Question
from apps.assessments.models import Test as Quiz
from apps.core import bulk
from apps.core.models import AuditEvent
from apps.learning.models import Course, Enrollment, Lesson, LessonCompletion, PublishState
from apps.scheduling.models import Booking, Circle

from .conftest import PW, client_for, make_user, occurrence

pytestmark = pytest.mark.django_db
A = "/api/v1/admin"


def act(c, resource, **body):
    return c.post(f"{A}/{resource}/bulk-action", body, format="json")


@pytest.fixture
def many(world):
    """Twelve extra active students (s1, s2 from `world` make 14), named so search and sort are predictable."""
    return [make_user(f"bulk{i:02d}@x.test", full_name=f"طالب {i:02d}") for i in range(12)]


# ---- authorization ------------------------------------------------------------------------
def test_only_admins_can_run_bulk_actions(world):
    for who in (world.s1, world.t1, world.p1):
        assert act(client_for(who), "users", action="suspend", ids=[world.s2.id], reason="x" * 5).status_code == 403
    assert act(APIClient(), "users", action="suspend", ids=[world.s2.id], reason="xxxx").status_code in (401, 403)
    world.s2.refresh_from_db()
    assert world.s2.status == AccountStatus.ACTIVE


def test_unknown_resource_or_action_is_refused(world):
    c = client_for(world.admin)
    assert act(c, "auditevents", action="delete", ids=[1]).status_code == 404       # audit log: no bulk endpoint at all
    assert act(c, "quran", action="delete", ids=[1]).status_code == 404             # canonical Quran text: none either
    r = act(c, "users", action="delete", ids=[world.s1.id])                          # people are never deleted
    assert r.status_code == 400 and r.json()["code"] == "invalid_action"
    assert User.objects.filter(pk=world.s1.id).exists()


# ---- ids mode -----------------------------------------------------------------------------
def test_select_ids_suspend_counts_skips_and_audit(world):
    c = client_for(world.admin)
    assert act(c, "users", action="suspend", ids=[world.s1.id]).json()["code"] == "invalid"  # reason required
    world.s2.status = AccountStatus.SUSPENDED
    world.s2.save()
    token, _ = AuthToken.issue(world.s1, device="phone")
    r = act(c, "users", action="suspend", ids=[world.s1.id, world.s2.id, world.p1.id], reason="مخالفة الشروط").json()
    assert (r["requested"], r["success"], r["skipped"], r["failed"]) == (3, 2, 1, 0)
    assert {x["id"]: x["outcome"] for x in r["results"]} == {world.s2.id: "skipped"}
    world.s1.refresh_from_db()
    token.refresh_from_db()
    assert world.s1.status == AccountStatus.SUSPENDED and token.revoked_at is not None  # signed out everywhere
    ev = AuditEvent.objects.get(action="admin.bulk_suspend")
    assert ev.actor == world.admin and ev.data["resource"] == "accounts.user" and ev.data["success"] == 2
    assert sorted(ev.data["ids"]) == sorted([world.s1.id, world.p1.id]) and ev.data["reason"] == "مخالفة الشروط"


def test_invalid_and_mixed_ids(world):
    c = client_for(world.admin)
    assert act(c, "users", action="activate", ids=[]).json()["code"] == "invalid"
    assert act(c, "users", action="activate", ids="1,2").json()["code"] == "invalid"
    assert act(c, "users", action="activate", ids=["x"]).json()["code"] == "invalid"
    assert act(c, "users", action="activate", ids=list(range(1, bulk.MAX_IDS + 2))).json()["code"] == "too_many"
    world.s1.status = AccountStatus.SUSPENDED
    world.s1.save()
    # An unknown id and an admin (never a target) are reported as failed; the valid one still runs.
    r = act(c, "users", action="activate", ids=[world.s1.id, 999999, world.admin.id, world.s1.id]).json()
    assert (r["requested"], r["success"], r["failed"]) == (3, 1, 2)
    assert {e["id"] for e in r["errors"]} == {999999, world.admin.id} and all(e["code"] == "not_found" for e in r["errors"])
    world.s1.refresh_from_db()
    assert world.s1.status == AccountStatus.ACTIVE


def test_each_record_is_its_own_transaction(world, monkeypatch):
    """A record that fails half-way is rolled back alone; the others are kept."""
    c = client_for(world.admin)
    real = bulk.REGISTRY["users"].actions["archive"].run

    def flaky(u, actor, reason):
        real(u, actor, reason)                 # writes the new status first…
        if u.pk == world.s2.id:
            raise bulk.Refuse("boom", "فشل مصطنع")  # …then fails: this record must roll back
    monkeypatch.setattr(bulk.REGISTRY["users"].actions["archive"], "run", flaky)
    r = act(c, "users", action="archive", ids=[world.s1.id, world.s2.id], reason="إغلاق الحساب").json()
    assert (r["success"], r["failed"]) == (1, 1) and r["errors"][0]["code"] == "boom"
    assert User.objects.get(pk=world.s1.id).status == AccountStatus.ARCHIVED
    assert User.objects.get(pk=world.s2.id).status == AccountStatus.ACTIVE


def test_archive_is_a_soft_delete(world):
    c = client_for(world.admin)
    r = act(c, "users", action="archive", ids=[world.s1.id], reason="طلب ولي الأمر").json()
    assert r["success"] == 1
    u = User.objects.get(pk=world.s1.id)  # still there, with its links and history
    assert u.status == AccountStatus.ARCHIVED and u.teacher_assignments.exists() and u.guardians.exists()
    login = APIClient().post("/api/v1/auth/login", {"email": u.email, "password": PW, "client": "native"}, format="json")
    assert login.status_code == 403
    # Hidden from the default list and "all" count; shown when asked for.
    assert world.s1.id not in [x["id"] for x in c.get(f"{A}/users", {"role": "student"}).json()["results"]]
    assert [x["id"] for x in c.get(f"{A}/users", {"role": "student", "status": "archived"}).json()["results"]] == [world.s1.id]
    counts = c.get(f"{A}/users/counts", {"role": "student"}).json()
    assert counts["archived"] == 1 and counts["all"] == 1
    assert act(c, "users", action="suspend", ids=[world.s1.id], reason="xxxx").json()["errors"][0]["code"] == "archived"
    assert act(c, "users", action="activate", ids=[world.s1.id]).json()["success"] == 1


def test_teacher_only_actions_refuse_other_roles(world):
    c = client_for(world.admin)
    r = act(c, "users", action="unapprove", ids=[world.t1.id, world.s1.id], reason="انتهى العقد").json()
    assert (r["success"], r["failed"]) == (1, 1) and r["errors"][0]["code"] == "not_teacher"
    assert world.t1.id not in [t["id"] for t in client_for(world.s1).get("/api/v1/teachers").json()["results"]]


# ---- filtered-all mode ------------------------------------------------------------------
def test_select_all_filtered_results_with_expected_count(world, many):
    c = client_for(world.admin)
    f = {"role": "student", "q": "طالب"}
    total = c.get(f"{A}/users", {**f, "page_size": 5}).json()["count"]
    assert total == 12
    stale = act(c, "users", action="suspend", filter=f, expected=11, reason="إيقاف جماعي")
    assert stale.status_code == 409 and stale.json()["code"] == "results_changed" and stale.json()["fields"]["expected"] == ["12"]
    assert not User.objects.filter(status=AccountStatus.SUSPENDED).exists()  # nothing happened
    keep = many[0].id
    r = act(c, "users", action="suspend", filter=f, expected=11, exclude_ids=[keep], reason="إيقاف جماعي").json()
    assert (r["requested"], r["success"]) == (11, 11)
    assert User.objects.filter(status=AccountStatus.SUSPENDED).count() == 11
    assert User.objects.get(pk=keep).status == AccountStatus.ACTIVE
    assert User.objects.get(pk=world.s1.id).status == AccountStatus.ACTIVE  # outside the filter
    assert AuditEvent.objects.get(action="admin.bulk_suspend").data["filter"] == f


def test_filter_mode_is_validated_strictly(world):
    c = client_for(world.admin)
    for bad in ({"role": "admin"}, {"status": "deleted"}, {"joined_from": "yesterday"}, {"is_superuser": "1"}, {"teacher": "abc"}):
        r = act(c, "users", action="activate", filter=bad, expected=0)
        assert r.status_code == 400 and r.json()["code"] == "invalid_filter", bad
    assert act(c, "users", action="activate", filter="role=student", expected=0).status_code == 400


def test_typed_confirmation_for_large_destructive_requests(world, many):
    c = client_for(world.admin)
    ids = [u.id for u in many[:10]]
    r = act(c, "users", action="archive", ids=ids, reason="تنظيف")
    assert r.status_code == 400 and r.json()["code"] == "confirm_required"
    assert act(c, "users", action="archive", ids=ids, reason="تنظيف", confirm="حذف").json()["success"] == 10


# ---- protected history --------------------------------------------------------------------
def test_delete_only_touches_empty_drafts(world):
    c = client_for(world.admin)
    empty = Course.objects.create(title="مسودة فارغة", teacher=world.t1)
    with_lesson = Course.objects.create(title="مسودة بدرس", teacher=world.t1)
    Lesson.objects.create(course=with_lesson, title="درس", kind="text", body="نص")
    published = Course.objects.create(title="منشورة", teacher=world.t1, state=PublishState.PUBLISHED)
    enrolled = Course.objects.create(title="بتسجيل", teacher=world.t1)
    Enrollment.objects.create(course=enrolled, student=world.s1)
    r = act(c, "courses", action="delete", ids=[empty.id, with_lesson.id, published.id, enrolled.id]).json()
    assert r["success"] == 1 and {e["id"]: e["code"] for e in r["errors"]} == {
        with_lesson.id: "has_history", published.id: "not_draft", enrolled.id: "has_history"}
    assert not Course.objects.filter(pk=empty.id).exists()
    assert Course.objects.filter(pk__in=[with_lesson.id, published.id, enrolled.id]).count() == 3


def test_protected_lessons_tests_circles(world):
    c = client_for(world.admin)
    course = Course.objects.create(title="د", teacher=world.t1)
    done = Lesson.objects.create(course=course, title="أكمله طالب", kind="text", body="ن")
    LessonCompletion.objects.create(student=world.s1, lesson=done)
    fresh = Lesson.objects.create(course=course, title="جديد", kind="text", body="ن")
    r = act(c, "lessons", action="delete", ids=[done.id, fresh.id]).json()
    assert r["success"] == 1 and r["errors"][0]["id"] == done.id and Lesson.objects.filter(pk=done.id).exists()

    attempted = Quiz.objects.create(title="جُرّب", author=world.t1)
    Attempt.objects.create(test=attempted, student=world.s1)
    unused = Quiz.objects.create(title="لم يُجرّب", author=world.t1)
    Question.objects.create(test=unused, order=1, kind="true_false", prompt="سؤال؟", options=[], answer_key=True)
    r = act(c, "tests", action="delete", ids=[attempted.id, unused.id]).json()
    assert r["success"] == 1 and Quiz.objects.filter(pk=attempted.id).exists() and not Quiz.objects.filter(pk=unused.id).exists()

    used = Circle.objects.create(name="لها جلسات", teacher=world.t1, capacity=4)
    occurrence(world.t1, circle=used)
    draft = Circle.objects.create(name="فارغة", teacher=world.t1, capacity=4)
    r = act(c, "circles", action="delete", ids=[used.id, draft.id]).json()
    assert r["success"] == 1 and Circle.objects.filter(pk=used.id).exists() and not Circle.objects.filter(pk=draft.id).exists()


def test_bulk_cancel_bookings_keeps_records_and_notifies(world):
    c = client_for(world.admin)
    future = Booking.objects.create(occurrence=occurrence(world.t1, in_hours=30), student=world.s1, idempotency_key="a")
    past = Booking.objects.create(occurrence=occurrence(world.t2, in_hours=-30), student=world.s2, idempotency_key="b", attendance="absent")
    r = act(c, "bookings", action="cancel", ids=[future.id, past.id], reason="إجازة المعلم").json()
    assert (r["success"], r["failed"]) == (1, 1) and r["errors"][0]["code"] == "already_started"
    future.refresh_from_db()
    past.refresh_from_db()
    assert future.status == "cancelled" and future.cancel_reason == "إجازة المعلم"
    assert past.status == "confirmed" and past.attendance == "absent"  # attendance history untouched
    assert Booking.objects.count() == 2


# ---- list: filters, search, sort, pagination ----------------------------------------------
def test_list_filters_search_sort_and_pagination(world, many):
    c = client_for(world.admin)
    page1 = c.get(f"{A}/users", {"role": "student", "sort": "name", "page_size": 5}).json()
    page3 = c.get(f"{A}/users", {"role": "student", "sort": "name", "page_size": 5, "page": 3}).json()
    assert page1["count"] == 14 and len(page1["results"]) == 5 and len(page3["results"]) == 4
    names = [u["full_name"] for u in c.get(f"{A}/users", {"role": "student", "sort": "name", "page_size": 100}).json()["results"]]
    assert names == sorted(names)
    desc = [u["full_name"] for u in c.get(f"{A}/users", {"role": "student", "sort": "-name", "page_size": 100}).json()["results"]]
    assert desc == names[::-1]
    assert c.get(f"{A}/users", {"sort": "password"}).json()["code"] == "invalid_filter"
    # search: name, email and id (reference)
    assert c.get(f"{A}/users", {"q": "bulk03@"}).json()["results"][0]["id"] == many[3].id
    assert c.get(f"{A}/users", {"q": str(many[4].id)}).json()["results"][0]["id"] == many[4].id
    # advanced filters
    assert [u["id"] for u in c.get(f"{A}/users", {"role": "student", "teacher": world.t1.id}).json()["results"]] == [world.s1.id]
    assert [u["id"] for u in c.get(f"{A}/users", {"role": "parent", "linked": "1"}).json()["results"]] == [world.p1.id]
    assert c.get(f"{A}/users", {"role": "parent", "linked": "0"}).json()["count"] == 0
    world.t2.teacher_profile.approved_at = None
    world.t2.teacher_profile.save()
    assert [u["id"] for u in c.get(f"{A}/users", {"role": "teacher", "approved": "0"}).json()["results"]] == [world.t2.id]
    occurrence(world.t1, in_hours=5)
    assert [u["id"] for u in c.get(f"{A}/users", {"role": "teacher", "has_slots": "1"}).json()["results"]] == [world.t1.id]
    User.objects.filter(pk=many[0].id).update(date_joined=timezone.now() - timedelta(days=40))
    old = c.get(f"{A}/users", {"role": "student", "joined_to": (timezone.localdate() - timedelta(days=30)).isoformat()}).json()
    assert [u["id"] for u in old["results"]] == [many[0].id]


def test_booking_and_content_filters(world):
    c = client_for(world.admin)
    b1 = Booking.objects.create(occurrence=occurrence(world.t1, in_hours=30), student=world.s1, idempotency_key="a")
    Booking.objects.create(occurrence=occurrence(world.t2, in_hours=50), student=world.s2, idempotency_key="b")
    r = c.get(f"{A}/bookings", {"teacher": world.t1.id}).json()
    assert [x["id"] for x in r["results"]] == [b1.id]
    assert c.get(f"{A}/bookings", {"student": world.s2.id, "status": "cancelled"}).json()["count"] == 0
    assert c.get(f"{A}/bookings", {"sort": "-starts"}).json()["results"][1]["id"] == b1.id
    Course.objects.create(title="التجويد 1", teacher=world.t1, state=PublishState.PUBLISHED)
    Course.objects.create(title="الحفظ", teacher=world.t2)
    assert [x["title"] for x in c.get(f"{A}/courses", {"teacher": world.t1.id}).json()["results"]] == ["التجويد 1"]
    assert c.get(f"{A}/courses", {"state": "draft", "q": "الحفظ"}).json()["count"] == 1
    assert c.get(f"{A}/tests", {"state": "nope"}).json()["code"] == "invalid_filter"
