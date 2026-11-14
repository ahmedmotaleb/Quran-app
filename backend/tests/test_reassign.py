"""Teacher reassignment (owner report 14 Nov 2026): an admin changes a student's teacher.

Each step is checked on its own: the database rows, what each account's API returns (the app's data), the
notification records, and the push attempts.
"""
import threading
from datetime import timedelta

import pytest
from django.db import connection
from django.utils import timezone

from apps.accounts.models import Role, TeacherAssignment
from apps.accounts.reassign import assign_teacher
from apps.learning.models import Assignment, Feedback, Submission
from apps.media.models import MediaObject
from apps.notifications.models import Notification, PushSubscription

from .conftest import client_for, make_user
from .test_push import FakePush, keys  # noqa: F401  (fixture)

pytestmark = [pytest.mark.usefixtures("commit_now")]
URL = "/api/v1/admin/teacher-assignments"


def phone(u):
    return PushSubscription.objects.create(user=u, endpoint=f"https://fcm.googleapis.com/fcm/send/re-{u.pk}", p256dh="p", auth="a", device="Android")


def history(teacher, student):
    """A task with a recording and an evaluation by `teacher` (memorization record)."""
    a = Assignment.objects.create(student=student, teacher=teacher, kind="hifz", title="الملك ١–٥", surah=67, ayah_from=1, ayah_to=5,
                                  due_at=timezone.now() + timedelta(days=1), status="accepted")
    m = MediaObject.objects.create(owner=student, purpose="recitation", key=f"rec/{a.pk}.webm", content_type="audio/webm")
    s = Submission.objects.create(assignment=a, student=student, media=m, attempt=1, duration_seconds=30, idempotency_key=f"h{a.pk}")
    f = Feedback.objects.create(submission=s, teacher=teacher, score_hifz=5, score_tajweed=5, score_fluency=5, decision="accept")
    return a, s, f


@pytest.mark.django_db
def test_full_reassignment_database_screens_notifications_and_push(world, keys, monkeypatch):  # noqa: F811
    fake = FakePush(monkeypatch)
    world.t1.gender, world.t2.gender, world.s1.gender = "male", "female", "male"
    for u in (world.t1, world.t2, world.s1):
        u.save()
        phone(u)
    old_task, old_sub, old_fb = history(world.t1, world.s1)

    r = client_for(world.admin).post(URL, {"teacher": world.t2.pk, "student": world.s1.pk}, format="json")
    assert r.status_code == 201, r.content
    body = r.json()
    assert body["teacher"] == world.t2.pk and body["teacher_name"] == "الأستاذة t2" and body["previous"]["teacher"] == world.t1.pk

    # 1. PostgreSQL: exactly one active assignment (t2); the old one ended and kept as history
    active = list(TeacherAssignment.objects.filter(student=world.s1, active=True))
    assert [a.teacher_id for a in active] == [world.t2.pk]
    old = TeacherAssignment.objects.get(student=world.s1, teacher=world.t1)
    assert not old.active and old.ended_at and old.ended_by == world.admin and old.end_reason == "reassigned"

    # 2. The student's app: `me.teacher` is the new teacher (read from the assignment, not from tasks)
    me = client_for(world.s1).get("/api/v1/me").json()
    assert me["teacher"]["id"] == world.t2.pk and me["teacher"]["name"] == "الأستاذة t2"

    # 3. New teacher sees the student; the previous one does not (and cannot read the student's recordings)
    assert world.s1.pk in [x["id"] for x in client_for(world.t2).get("/api/v1/teacher/students").json()["results"]]
    assert world.s1.pk not in [x["id"] for x in client_for(world.t1).get("/api/v1/teacher/students").json()["results"]]
    assert client_for(world.t1).get(f"/api/v1/submissions/{old_sub.pk}").status_code == 404
    assert client_for(world.t2).get(f"/api/v1/submissions/{old_sub.pk}").status_code == 200   # the new teacher sees the history

    # 4. Notifications: the owner's wording, one each, with the gendered title (never «الشيخ»)
    n_s = Notification.objects.get(recipient=world.s1, kind="teacher_assigned")
    assert n_s.title == "تم تغيير معلمك في حلقة"
    assert n_s.body == "تم تعيين الأستاذة t2 معلمةً لك. يمكنك الآن متابعة الحفظ والمراجعة معها."
    n_t2 = Notification.objects.get(recipient=world.t2, kind="student_assigned")
    assert (n_t2.title, n_t2.body) == ("طالب جديد في حلقتك", "تم تعيين الطالب s1 ضمن طلابك.")
    n_t1 = Notification.objects.get(recipient=world.t1, kind="student_moved")
    assert (n_t1.title, n_t1.body) == ("تحديث قائمة الطلاب", "تم نقل الطالب s1 إلى معلم آخر.")
    assert "الشيخ" not in n_s.body

    # 5. Push attempted and logged on each notification (the owner's text on the phone)
    titles = sorted(p["title"] for _, p in fake.sent)
    assert titles == sorted(["تم تغيير معلمك في حلقة", "طالب جديد في حلقتك", "تحديث قائمة الطلاب"])
    for n in (n_s, n_t2, n_t1):
        n.refresh_from_db()
        assert n.push_status == "sent" and n.push_attempts == 1

    # 6. "Restart": a fresh client reads the same authoritative state
    assert client_for(world.s1).get("/api/v1/me").json()["teacher"]["id"] == world.t2.pk

    # 7. History intact: the task, the recording and the evaluation are all still there
    assert Assignment.objects.filter(pk=old_task.pk, teacher=world.t1).exists()
    assert Submission.objects.filter(pk=old_sub.pk).exists() and Feedback.objects.filter(pk=old_fb.pk, teacher=world.t1).exists()
    assert old_task.pk in [x["id"] for x in client_for(world.s1).get("/api/v1/assignments").json()["results"]]


@pytest.mark.django_db
def test_same_teacher_again_changes_nothing_and_notifies_no_one(world):
    r = client_for(world.admin).post(URL, {"teacher": world.t1.pk, "student": world.s1.pk}, format="json")
    assert r.status_code == 200
    assert TeacherAssignment.objects.filter(student=world.s1, active=True).count() == 1
    assert not Notification.objects.filter(kind__in=["teacher_assigned", "student_assigned", "student_moved"]).exists()


@pytest.mark.django_db
def test_titles_follow_gender_and_never_default_to_sheikh(world):
    t3 = make_user("t3@x.test", Role.TEACHER, full_name="خالد العمري", gender="male")
    t4 = make_user("t4@x.test", Role.TEACHER, full_name="سعاد", gender="")
    assign_teacher(world.s1, t3, world.admin, source="test")
    assert "تم تعيين الأستاذ خالد العمري معلمًا لك" in Notification.objects.filter(recipient=world.s1).latest("id").body
    assign_teacher(world.s1, t4, world.admin, source="test")
    body = Notification.objects.filter(recipient=world.s1).latest("id").body
    assert body.startswith("تم تعيين سعاد معلمًا لك") and "الشيخ" not in body


@pytest.mark.django_db
def test_offline_student_and_push_outage_never_undo_the_reassignment(world, keys, monkeypatch):  # noqa: F811
    FakePush(monkeypatch, fail_status=503)       # the push service is down
    phone(world.t2)                              # the student has no device (offline / never enabled)
    assign_teacher(world.s1, world.t2, world.admin, source="test")
    assert TeacherAssignment.objects.get(student=world.s1, active=True).teacher == world.t2
    n_s = Notification.objects.get(recipient=world.s1, kind="teacher_assigned")
    assert n_s.push_status == "no_device" and n_s.read_at is None                      # waits in the app's inbox
    assert client_for(world.s1).get("/api/v1/notifications/unread").json()["unread"] >= 1
    n_t2 = Notification.objects.get(recipient=world.t2, kind="student_assigned")
    assert n_t2.push_status in ("retry", "failed") and n_t2.push_attempts == 1 and n_t2.push_error   # logged for the hourly retry


@pytest.mark.django_db
def test_a_failed_reassignment_sends_nothing(world):
    world.t2.status = "suspended"
    world.t2.save()
    r = client_for(world.admin).post(URL, {"teacher": world.t2.pk, "student": world.s1.pk}, format="json")
    assert r.status_code == 400
    assert TeacherAssignment.objects.get(student=world.s1, active=True).teacher == world.t1
    assert not Notification.objects.filter(kind__in=["teacher_assigned", "student_assigned", "student_moved"]).exists()


@pytest.mark.django_db
def test_only_admins_with_teachers_assign_may_reassign(world):
    for who in (world.s1, world.t1, world.p1):
        assert client_for(who).post(URL, {"teacher": world.t2.pk, "student": world.s1.pk}, format="json").status_code == 403
    assert TeacherAssignment.objects.get(student=world.s1, active=True).teacher == world.t1


@pytest.mark.django_db
def test_assignment_rev_moves_for_the_three_people_only(world):
    def rev(u):
        return client_for(u).get("/api/v1/notifications/unread").json()["assignment_rev"]

    before = {u.pk: rev(u) for u in (world.s1, world.t1, world.t2, world.s2)}
    assign_teacher(world.s1, world.t2, world.admin, source="test")
    for u in (world.s1, world.t1, world.t2):
        assert rev(u) != before[u.pk]
    assert rev(world.s2) == before[world.s2.pk]


@pytest.mark.django_db
def test_new_recordings_go_to_the_new_teacher_only(world, settings, tmp_path):
    from apps.media.storage import get_storage

    settings.MEDIA_STORAGE, settings.MEDIA_LOCAL_ROOT = "local", tmp_path / "media"
    get_storage.cache_clear()
    a = Assignment.objects.create(student=world.s1, teacher=world.t1, kind="hifz", title="مفتوحة", surah=67, ayah_from=1, ayah_to=5,
                                  due_at=timezone.now() + timedelta(days=1), status="in_progress")
    assign_teacher(world.s1, world.t2, world.admin, source="test")
    from .test_media_submissions import submit, upload

    c = client_for(world.s1)
    r = submit(c, a, upload(c).json()["id"])
    assert r.status_code == 201, r.content
    assert Notification.objects.filter(recipient=world.t2, kind="submission_new").exists()
    assert not Notification.objects.filter(recipient=world.t1, kind="submission_new").exists()
    sid = r.json()["id"]
    assert client_for(world.t1).get(f"/api/v1/submissions/{sid}").status_code == 404


@pytest.mark.django_db
def test_bulk_assign_needs_replace_to_move_a_student(world):
    c = client_for(world.admin)
    url = "/api/v1/admin/users/bulk-action"
    r = c.post(url, {"action": "assign_teacher", "ids": [world.s1.pk], "params": {"teacher": world.t2.pk}}, format="json")
    assert r.status_code == 200, r.content
    assert TeacherAssignment.objects.get(student=world.s1, active=True).teacher == world.t1      # skipped: has a teacher
    r = c.post(url, {"action": "assign_teacher", "ids": [world.s1.pk], "params": {"teacher": world.t2.pk, "replace": True}}, format="json")
    assert r.status_code == 200, r.content
    assert TeacherAssignment.objects.get(student=world.s1, active=True).teacher == world.t2
    assert Notification.objects.filter(recipient=world.t1, kind="student_moved").exists()


@pytest.mark.django_db
def test_database_refuses_two_active_teachers(world):
    from django.db import IntegrityError, transaction

    with pytest.raises(IntegrityError), transaction.atomic():
        TeacherAssignment.objects.create(teacher=world.t2, student=world.s1)


@pytest.mark.django_db
def test_repair_migration_ends_duplicates_and_keeps_the_newest(world):
    """Existing data: a student linked to two teachers by the old «ربط بمعلم». The migration keeps the newest active,
    ends (never deletes) the others, and audits each."""
    import importlib

    from django.apps import apps as global_apps

    from apps.core.models import AuditEvent

    mig = importlib.import_module("apps.accounts.migrations.0017_teacher_assignment_single_active")
    with connection.cursor() as cur:
        cur.execute("DROP INDEX one_active_teacher_per_student")      # recreate the old state (rolled back after the test)
    newer = TeacherAssignment.objects.create(teacher=world.t2, student=world.s1)
    mig.repair_duplicates(global_apps, None)
    old = TeacherAssignment.objects.get(student=world.s1, teacher=world.t1)
    assert not old.active and old.end_reason == "repair_duplicate" and old.ended_at
    assert TeacherAssignment.objects.filter(student=world.s1, active=True).get() == newer
    assert TeacherAssignment.objects.filter(student=world.s1).count() == 2                   # nothing deleted
    ev = AuditEvent.objects.get(action="data.teacher_assignment_repaired")
    assert ev.data["ended_teacher"] == world.t1.pk and ev.data["kept_teacher"] == world.t2.pk


@pytest.mark.django_db(transaction=True)
def test_simultaneous_reassignments_leave_exactly_one_active_teacher(world):
    t3 = make_user("t3@x.test", Role.TEACHER)
    errors, done = [], []
    barrier = threading.Barrier(2)

    def run(t):
        from django.db import connection as conn

        try:
            barrier.wait()
            r = client_for(world.admin).post(URL, {"teacher": t.pk, "student": world.s1.pk}, format="json")
            done.append(r.status_code)
        except Exception as e:  # noqa: BLE001
            errors.append(repr(e))
        finally:
            conn.close()

    th = [threading.Thread(target=run, args=(t,)) for t in (world.t2, t3)]
    for x in th:
        x.start()
    for x in th:
        x.join()
    assert not errors and sorted(done) == [201, 201]                                         # both succeed, one after the other
    rows = TeacherAssignment.objects.filter(student=world.s1)
    assert rows.filter(active=True).count() == 1 and rows.count() == 3                       # t1 → (t2|t3) → (t3|t2)
    last = rows.get(active=True).teacher_id
    me = client_for(world.s1).get("/api/v1/me").json()
    assert me["teacher"]["id"] == last
