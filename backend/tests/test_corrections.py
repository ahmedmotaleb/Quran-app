"""Pack prompt 33: student mistakes tracking and correction history."""
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.core.models import AuditEvent
from apps.learning.models import Assignment, Correction, Submission
from apps.media.models import MediaObject
from apps.notifications.models import Notification
from apps.scheduling.models import Booking

from .conftest import client_for, occurrence

pytestmark = pytest.mark.django_db
URL = "/api/v1/corrections"


def task(w, student=None, teacher=None):
    return Assignment.objects.create(student=student or w.s1, teacher=teacher or w.t1, kind="hifz", title="حفظ سورة الملك",
                                     surah=67, ayah_from=1, ayah_to=10, due_at=timezone.now() + timedelta(days=1))


def submission(w, a):
    m = MediaObject.objects.create(owner=a.student, purpose="recitation", key=f"rec/{a.pk}.webm", content_type="audio/webm")
    return Submission.objects.create(assignment=a, student=a.student, media=m, attempt=1, duration_seconds=30, idempotency_key=f"k{a.pk}")


def add(user, **kw):
    body = {"student": kw.pop("student"), "source": "task", "surah": 67, "ayah": 3, "category": "madd", "note": "انتبه للمد",
            "guidance": "مد طبيعي حركتان", "internal_note": "يحتاج متابعة هادئة", **kw}
    return client_for(user).post(URL, body, format="json")


def test_teacher_records_for_own_student_with_notification_and_audit(world, django_capture_on_commit_callbacks):
    a = task(world)
    with django_capture_on_commit_callbacks(execute=True):
        r = add(world.t1, student=world.s1.pk, assignment=a.pk)
    assert r.status_code == 201, r.json()
    d = r.json()
    assert d["category_label"] == "المدود" and d["status"] == "new" and d["times"] == 1 and d["internal_note"]
    assert AuditEvent.objects.filter(action="correction.created").count() == 1
    n = Notification.objects.get(recipient=world.s1, kind="correction_new")
    assert n.title == "أضاف معلمك ملاحظة جديدة للمراجعة" and "انتبه" not in n.body  # free text stays in the app


def test_idor_and_role_rules_on_create(world):
    assert add(world.t1, student=world.s2.pk).status_code == 403              # not their student
    assert add(world.t2, student=world.s1.pk).status_code == 403
    assert add(world.s1, student=world.s1.pk).status_code == 403              # students cannot write
    assert add(world.p1, student=world.s1.pk).status_code == 403
    other = task(world, student=world.s2, teacher=world.t2)
    r = add(world.t1, student=world.s1.pk, assignment=other.pk)               # someone else's task
    assert r.status_code == 400 and "assignment" in r.json()["fields"]
    sub = submission(world, other)
    assert add(world.t1, student=world.s1.pk, source="submission", submission=sub.pk).status_code == 400
    assert add(world.t1, student=world.s1.pk, source="submission").json()["fields"]["submission"]
    assert add(world.t1, student=world.s1.pk, ayah=31).json()["fields"]["ayah"]  # al-Mulk has 30 ayat
    assert add(world.t1, student=world.s1.pk, category="bogus").status_code == 400
    assert Correction.objects.count() == 0


def test_links_to_submission_and_session(world):
    a = task(world)
    sub = submission(world, a)
    r = add(world.t1, student=world.s1.pk, source="submission", submission=sub.pk)
    assert r.status_code == 201 and r.json()["submission"] == sub.pk and r.json()["assignment"] == a.pk
    o = occurrence(world.t1, in_hours=-1)
    b = Booking.objects.create(occurrence=o, student=world.s1, idempotency_key="b1")
    assert add(world.t1, student=world.s1.pk, source="session", booking=b.pk).status_code == 201
    o2 = occurrence(world.t2, in_hours=-1)
    b2 = Booking.objects.create(occurrence=o2, student=world.s1, idempotency_key="b2")
    assert add(world.t1, student=world.s1.pk, source="session", booking=b2.pk).status_code == 400  # another teacher's session
    assert client_for(world.s1).get(f"{URL}?submission={sub.pk}").json()["count"] == 1


def test_visibility_student_parent_teacher(world):
    add(world.t1, student=world.s1.pk)
    add(world.t2, student=world.s2.pk)
    mine = client_for(world.s1).get(URL).json()["results"]
    assert len(mine) == 1 and mine[0]["note"] == "انتبه للمد" and "internal_note" not in mine[0]
    par = client_for(world.p1).get(URL).json()["results"]
    assert len(par) == 1
    assert not {"note", "guidance", "internal_note", "teacher_name", "submission"} & set(par[0])  # parent-safe
    assert client_for(world.t1).get(URL).json()["count"] == 1
    assert client_for(world.t2).get(f"{URL}?student={world.s1.pk}").json()["count"] == 0
    cid = Correction.objects.get(student=world.s1).pk
    assert client_for(world.s2).get(f"{URL}/{cid}").status_code == 404
    assert client_for(world.t2).patch(f"{URL}/{cid}", {"status": "corrected"}, format="json").status_code == 404
    assert client_for(world.s1).patch(f"{URL}/{cid}", {"status": "corrected"}, format="json").status_code == 403
    assert client_for(world.p1).patch(f"{URL}/{cid}", {"status": "corrected"}, format="json").status_code == 403
    assert client_for(world.p1).get(f"{URL}/summary?student={world.s2.pk}").status_code == 404
    assert client_for(world.t2).get(f"{URL}/summary?student={world.s1.pk}").status_code == 404


def test_recurrence_and_filters(world):
    for _ in range(3):
        add(world.t1, student=world.s1.pk)
    add(world.t1, student=world.s1.pk, ayah=5, category="ghunnah")
    c = client_for(world.s1)
    rows = c.get(URL).json()["results"]
    assert sorted(r["times"] for r in rows) == [1, 3, 3, 3]
    assert c.get(f"{URL}?recurring=1").json()["count"] == 3
    assert c.get(f"{URL}?category=ghunnah").json()["count"] == 1
    assert c.get(f"{URL}?surah=x").status_code == 400


def test_resolve_reopen_with_audit_and_summary(world):
    cid = add(world.t1, student=world.s1.pk).json()["id"]
    add(world.t1, student=world.s1.pk)
    t = client_for(world.t1)
    r = t.patch(f"{URL}/{cid}", {"status": "corrected"}, format="json")
    assert r.status_code == 200 and r.json()["resolved_at"]
    assert AuditEvent.objects.filter(action="correction.resolved").exists()
    s = client_for(world.s1).get(f"{URL}/summary").json()
    assert s["open"] == 1 and s["corrected"] == 1 and s["recurring"] == 1
    assert s["by_category"][0]["category"] == "madd" and s["trend"]
    assert client_for(world.p1).get(f"{URL}/summary?student={world.s1.pk}").json()["corrected"] == 1
    r = t.patch(f"{URL}/{cid}", {"status": "improving"}, format="json")
    assert r.json()["resolved_at"] is None and AuditEvent.objects.filter(action="correction.reopened").exists()
    assert t.patch(f"{URL}/{cid}", {"status": "done"}, format="json").status_code == 400


def test_follow_up_task(world, django_capture_on_commit_callbacks):
    cid = add(world.t1, student=world.s1.pk).json()["id"]
    t = client_for(world.t1)
    assert client_for(world.t2).post(f"{URL}/{cid}/follow-up", {"kind": "ayah"}, format="json").status_code == 404
    with django_capture_on_commit_callbacks(execute=True):
        r = t.post(f"{URL}/{cid}/follow-up", {"kind": "tajweed", "days": 3}, format="json")
    assert r.status_code == 201
    a = Assignment.objects.get(pk=r.json()["assignment"])
    assert a.student == world.s1 and a.surah == 67 and a.ayah_from == a.ayah_to == 3 and a.kind == "tajweed"
    assert r.json()["correction"]["status"] == "improving" and r.json()["correction"]["follow_up"] == a.pk
    assert t.post(f"{URL}/{cid}/follow-up", {"kind": "ayah"}, format="json").status_code == 409
    assert Notification.objects.filter(recipient=world.s1, kind="assignment_new").exists()
    assert AuditEvent.objects.filter(action="correction.follow_up_created").exists()


def test_teacher_overview_and_admin_aggregate(world):
    add(world.t1, student=world.s1.pk, category="hifz")
    add(world.t1, student=world.s1.pk, category="hifz")
    add(world.t2, student=world.s2.pk, category="madd")
    o = client_for(world.t1).get("/api/v1/teacher/corrections/overview").json()
    assert o["students_with_open"][0]["open"] == 2 and len(o["repeated_memorization"]) == 2 and o["repeated_tajweed"] == []
    assert client_for(world.s1).get("/api/v1/teacher/corrections/overview").status_code == 403
    adm = client_for(world.admin).get("/api/v1/admin/corrections/summary")
    body = adm.json()
    assert adm.status_code == 200 and body["total"] == 3 and body["students_with_open"] == 2 and "note" not in str(body)
    assert client_for(world.t1).get("/api/v1/admin/corrections/summary").status_code == 403
    cats = client_for(world.s1).get(f"{URL}/categories").json()
    assert len(cats) == 15 and cats[0]["memorization"] is True
