"""PROMPT 50: CSV student import. Dry-run preview first, then commit; duplicates and errors are reported (never
silently skipped); no passwords, no verified phones, no duplicate emails; teacher and circle rules apply."""
from django.core.files.uploadedfile import SimpleUploadedFile
import pytest

from apps.accounts.models import Role, TeacherAssignment, User
from apps.core.models import AuditEvent
from apps.scheduling.models import Circle, CircleMember

from .conftest import client_for, make_user
from .test_admins import mailbox, staff  # noqa: F401  (fixture)

pytestmark = pytest.mark.django_db
URL = "/api/v1/admin/import/students"
HEAD = "full_name,email,phone,timezone,level,teacher_email,circle\n"


def csv_file(body: str, header: str = HEAD, enc: str = "utf-8-sig") -> SimpleUploadedFile:
    return SimpleUploadedFile("students.csv", (header + body).encode(enc), content_type="text/csv")


def post(c, body, dry=True, **kw):
    return c.post(URL, {"file": csv_file(body, **kw), "dry_run": "true" if dry else "false"}, format="multipart")


@pytest.fixture
def circle(world):
    return Circle.objects.create(name="حلقة الفجر", teacher=world.t1, capacity=2, state="published")


def test_preview_then_commit(world, circle, mailbox):
    c = client_for(world.admin)
    body = (f"أحمد علي,ahmed@x.test,01012345678,Africa/Cairo,مبتدئ,{world.t1.email},حلقة الفجر\n"
            "منى سالم,MONA@x.test,,,,,\n"
            f"مكرر,{world.s1.email},,,,,\n"          # an existing account
            "منى مرة أخرى,mona@x.test,,,,,\n"       # repeats in the file
            "س,bad-email,123,Mars/Base,,nobody@x.test,حلقة غير موجودة\n")
    r = post(c, body)
    assert r.status_code == 200 and r.json()["dry_run"] is True
    rows = r.json()["rows"]
    assert [x["status"] for x in rows] == ["valid", "valid", "duplicate", "duplicate", "error"]
    assert rows[0]["clean"]["phone"] == "+201012345678" and rows[1]["clean"]["email"] == "mona@x.test"
    assert rows[1]["clean"]["timezone"] == "Africa/Cairo"  # the platform default
    assert len(rows[4]["errors"]) >= 5 and rows[4]["line"] == 6
    assert r.json()["summary"] == {"valid": 2, "duplicate": 2, "error": 1, "total": 5}
    assert not User.objects.filter(email="ahmed@x.test").exists()  # a preview writes nothing
    r = post(c, body, dry=False)
    res = r.json()
    assert res["result"]["created"] == 2 and res["result"]["skipped"] == 3 and res["result"]["emails"]["sent"] == 2
    assert [x.get("result") for x in res["rows"]] == ["created", "created", "skipped", "skipped", "skipped"]
    a = User.objects.get(email="ahmed@x.test")
    assert a.role == Role.STUDENT and not a.has_usable_password() and a.phone == "+201012345678"
    assert a.phone_e164 == "" and a.phone_verified_at is None  # never auto-verified
    assert a.student_profile.level == "مبتدئ" and a.setup_email_status == "sent"
    assert TeacherAssignment.objects.filter(teacher=world.t1, student=a, active=True).exists()
    assert CircleMember.objects.filter(circle=circle, student=a, active=True).exists()
    assert User.objects.filter(email="mona@x.test").count() == 1
    assert {m.to[0] for m in mailbox} >= {"ahmed@x.test", "mona@x.test"}
    ev = AuditEvent.objects.get(action="admin.students_imported")
    assert ev.data["created"] == 2 and ev.data["skipped"] == 3 and "ahmed@x.test" not in str(ev.data)
    assert AuditEvent.objects.filter(action="admin.user_created", data__source="csv_import").count() == 2
    # Importing the same file again creates nobody.
    again = post(c, body, dry=False).json()
    assert again["result"]["created"] == 0 and again["summary"]["duplicate"] == 4


def test_circle_capacity_counts_across_the_file(world, circle):
    CircleMember.objects.create(circle=circle, student=world.s2)  # 1 of 2 seats taken
    body = "".join(f"طالب {i},k{i}@x.test,,,,,حلقة الفجر\n" for i in range(3))
    rows = post(client_for(world.admin), body).json()["rows"]
    assert [x["status"] for x in rows] == ["valid", "error", "error"] and "لا مقاعد" in rows[1]["errors"][0]
    Circle.objects.create(name="حلقة الفجر", teacher=world.t2, capacity=5, state="published")  # same name twice
    rows = post(client_for(world.admin), "x y,z@x.test,,,,,حلقة الفجر\n").json()["rows"]
    assert "رقم الحلقة" in rows[0]["errors"][0]
    rows = post(client_for(world.admin), f"x y,z@x.test,,,,,{circle.pk}\n").json()["rows"]
    assert rows[0]["status"] == "valid"


def test_unapproved_or_inactive_teacher_is_refused(world):
    t = make_user("new-t@x.test", Role.TEACHER)
    t.teacher_profile.approved_at = None
    t.teacher_profile.save()
    rows = post(client_for(world.admin), "a b,ab@x.test,,,,new-t@x.test,\n").json()["rows"]
    assert rows[0]["status"] == "error" and "غير معتمد" in rows[0]["errors"][0]


def test_file_level_checks(world):
    c = client_for(world.admin)
    assert post(c, "a,b@x.test\n", header="full_name,email,password\n").status_code == 400  # unknown column
    assert post(c, "a\n", header="full_name\n").status_code == 400  # email column missing
    assert post(c, "").status_code == 400  # header only
    assert post(c, "أحمد,a@x.test,,,,,\n", enc="cp1256").status_code == 400  # not UTF-8
    r = post(c, "a b,a@x.test,,,,,,extra\n")
    assert r.json()["rows"][0]["status"] == "error"  # extra cells are an error, not ignored
    big = "".join(f"n {i},n{i}@x.test,,,,,\n" for i in range(501))
    assert post(c, big).status_code == 400
    assert c.post(URL, {"dry_run": "true"}, format="multipart").status_code == 400  # no file
    # Excel-style header with BOM and upper case is accepted.
    assert post(c, "a b,ab@x.test\n", header="FULL_NAME,Email\n").status_code == 200


def test_permissions(world):
    body = f"a b,ab@x.test,,,,{world.t1.email},\n"
    assert post(client_for(world.t1), body).status_code == 403
    viewer = staff("v@x.test", perms=["users.view"])
    assert post(client_for(viewer), "a b,ab@x.test,,,,,\n").status_code == 403
    creator = staff("cr@x.test", perms=["users.view", "users.create"])
    cc = client_for(creator)
    assert post(cc, "a b,ab@x.test,,,,,\n").status_code == 200
    r = post(cc, body)  # teacher column without teachers.assign
    assert r.status_code == 400 and "teacher_email" in r.json()["message"]
    assert post(cc, "a b,ab@x.test,,,,,حلقة\n").status_code == 400  # circle column without circles.manage
    assert post(cc, "a b,ab@x.test,0101,,,,\n").status_code == 400  # phone column without users.view_contact
    t = cc.get(URL)
    assert t.status_code == 200 and t.content.decode("utf-8").startswith("﻿full_name,email,phone,timezone,level,teacher_email,circle")


def test_a_row_failing_at_commit_does_not_block_the_others(world, circle, monkeypatch):
    from apps.accounts import student_import as si

    real = si.create_row
    calls = {"n": 0}

    def flaky(row, admin, request):
        calls["n"] += 1
        if calls["n"] == 1:
            from apps.scheduling.membership import MembershipError

            raise MembershipError("circle_full", "اكتملت الحلقة.", 409)
        return real(row, admin, request)

    monkeypatch.setattr(si, "create_row", flaky)
    res = post(client_for(world.admin), "a b,ab@x.test,,,,,\nc d,cd@x.test,,,,,\n", dry=False).json()
    assert [x["result"] for x in res["rows"]] == ["failed", "created"] and res["rows"][0]["errors"] == ["اكتملت الحلقة."]
    assert res["result"] == {"created": 1, "skipped": 0, "failed": 1, "emails": res["result"]["emails"]}
    assert not User.objects.filter(email="ab@x.test").exists() and User.objects.filter(email="cd@x.test").exists()


def test_emails_over_the_time_budget_are_queued_for_the_hourly_job(world, mailbox, monkeypatch):
    from io import StringIO

    from django.core.management import call_command

    from apps.accounts import student_import as si

    monkeypatch.setattr(si, "EMAIL_BUDGET_SECONDS", -1)  # no time left: every email is queued
    res = post(client_for(world.admin), "a b,ab@x.test,,,,,\nc d,cd@x.test,,,,,\n", dry=False).json()
    assert res["result"]["emails"] == {"sent": 0, "failed": 0, "pending": 2} and len(mailbox) == 0
    assert set(User.objects.filter(setup_email_status="pending").values_list("email", flat=True)) == {"ab@x.test", "cd@x.test"}
    done = User.objects.get(email="cd@x.test")
    done.set_password("a-strong-pass-123"); done.save()  # set a password meanwhile: no email needed any more
    out = StringIO()
    call_command("send_pending_setup_emails", stdout=out)
    assert "sent 1" in out.getvalue() and "cleared 1" in out.getvalue() and "still queued 0" in out.getvalue()
    assert [m.to[0] for m in mailbox] == ["ab@x.test"]
    assert User.objects.get(email="ab@x.test").setup_email_status == "sent"
    out = StringIO()
    call_command("send_pending_setup_emails", stdout=out)
    assert "sent 0" in out.getvalue() and len(mailbox) == 1  # never twice
