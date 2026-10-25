"""Teacher titles (owner request, 25 Oct 2026): «الشيخ» / «الأستاذة» before every teacher's name wherever it is shown;
the stored name never changes; never doubled; students, parents and admins as they are."""
import pytest

from apps.accounts.display import display_name, strip_title, teacher_name
from apps.accounts.models import Role, User
from apps.notifications.models import Notification
from apps.scheduling import services

from .conftest import client_for, make_user, occurrence

pytestmark = pytest.mark.django_db


@pytest.mark.parametrize("name,gender,shown", [
    ("أحمد محمد", "male", "الشيخ أحمد محمد"),
    ("محمد علي", "male", "الشيخ محمد علي"),
    ("مريم أحمد", "female", "الأستاذة مريم أحمد"),
    ("سارة محمود", "female", "الأستاذة سارة محمود"),
    ("الشيخ أحمد محمد", "male", "الشيخ أحمد محمد"),             # never doubled
    ("الأستاذة الأستاذة مريم أحمد", "female", "الأستاذة مريم أحمد"),
    ("الشيخ مريم علي", "female", "الأستاذة مريم علي"),            # a wrong stored title is corrected
    ("الشيخ عبدالرحمن السالم", "male", "الشيخ عبدالرحمن السالم"),
    ("أ. هدى الزهراني", "female", "الأستاذة هدى الزهراني"),
    ("  أحمد   ", "male", "الشيخ أحمد"),
    ("أحمد محمد", "", "أحمد محمد"),                                 # gender not set: no guessed title
])
def test_formatter(name, gender, shown):
    assert teacher_name(name, gender) == shown


def test_title_alone_is_not_stripped_to_nothing():
    assert strip_title("الشيخ") == "الشيخ"


def test_only_teachers_get_a_title(world):
    for u in (world.s1, world.p1, world.admin):
        u.gender = "male"
        u.full_name = "أحمد محمد"
        u.save()
        assert display_name(u) == "أحمد محمد"
    world.t1.full_name, world.t1.gender = "أحمد محمد", "male"
    assert display_name(world.t1) == "الشيخ أحمد محمد"
    world.t1.status = "deleted"
    assert display_name(world.t1) == "أحمد محمد"


def _teachers(world):
    world.t1.full_name, world.t1.gender = "أحمد محمد", "male"
    world.t1.save()
    world.t2.full_name, world.t2.gender = "مريم علي", "female"
    world.t2.save()


def test_api_display_fields_and_clean_stored_names(world, django_capture_on_commit_callbacks):
    _teachers(world)
    names = {t["id"]: t for t in client_for(world.s1).get("/api/v1/teachers").json()["results"]}
    assert names[world.t1.pk]["display_name"] == "الشيخ أحمد محمد" and names[world.t1.pk]["full_name"] == "أحمد محمد"
    assert names[world.t2.pk]["display_name"] == "الأستاذة مريم علي"
    o = occurrence(world.t2, in_hours=48)
    with django_capture_on_commit_callbacks(execute=True):
        b, _ = services.book(student=world.s1, occurrence_id=o.pk, idempotency_key="title-1")
    row = client_for(world.s1).get(f"/api/v1/bookings/{b.pk}").json()
    assert row["occurrence"]["teacher_name"] == "الأستاذة مريم علي" and row["student_name"] == world.s1.full_name
    n = Notification.objects.get(recipient=world.s1, kind="booking_confirmed")
    assert "مع الأستاذة مريم علي" in n.body
    assert "الشيخ" not in Notification.objects.get(recipient=world.t2, kind="booking_new").body   # the student's name, untitled
    me = client_for(world.t1).get("/api/v1/me").json()
    assert me["full_name"] == "أحمد محمد" and me["display_name"] == "الشيخ أحمد محمد" and me["gender"] == "male"
    assert client_for(world.s1).get("/api/v1/me").json()["display_name"] == world.s1.full_name
    slot = client_for(world.s1).get(f"/api/v1/teachers/{world.t2.pk}/slots").json()
    assert all(x["teacher_name"] == "الأستاذة مريم علي" for x in slot)


def test_titles_are_never_stored(world):
    r = client_for(world.t1).patch("/api/v1/me", {"full_name": "الشيخ أحمد محمد", "gender": "male"}, format="json")
    assert r.status_code == 200 and r.json()["full_name"] == "أحمد محمد" and r.json()["display_name"] == "الشيخ أحمد محمد"
    assert User.objects.get(pk=world.t1.pk).full_name == "أحمد محمد"
    r = client_for(world.admin).patch(f"/api/v1/admin/users/{world.t2.pk}", {"full_name": "الأستاذة مريم علي", "gender": "female"}, format="json")
    assert r.status_code == 200 and r.json()["full_name"] == "مريم علي" and r.json()["display_name"] == "الأستاذة مريم علي"
    assert client_for(world.admin).patch(f"/api/v1/admin/users/{world.t2.pk}", {"gender": "other"}, format="json").status_code == 400
    # a student may be called «أستاذ…»-anything: nothing is removed from non-teachers
    client_for(world.s1).patch("/api/v1/me", {"full_name": "الشيخ يوسف"}, format="json")
    assert User.objects.get(pk=world.s1.pk).full_name == "الشيخ يوسف"


def test_admin_creates_teacher_with_gender(world):
    r = client_for(world.admin).post("/api/v1/admin/teachers", {"full_name": "الأستاذة هدى الزهراني", "email": "huda@x.test", "gender": "female"},
                                     format="json")
    assert r.status_code == 201
    u = User.objects.get(email="huda@x.test")
    assert u.full_name == "هدى الزهراني" and u.gender == "female" and u.role == Role.TEACHER
    assert r.json()["display_name"] == "الأستاذة هدى الزهراني"
    listed = client_for(world.admin).get("/api/v1/admin/users", {"role": "teacher"}).json()["results"]
    assert {x["display_name"] for x in listed} >= {"الأستاذة هدى الزهراني"}


def test_student_named_like_a_teacher_is_untitled(world):
    s = make_user("ahmed@x.test", full_name="أحمد محمد", gender="male")
    assert display_name(s) == "أحمد محمد"
    row = client_for(world.admin).get(f"/api/v1/admin/users/{s.pk}").json()
    assert row["display_name"] == "أحمد محمد"


def test_signup_asks_for_gender():
    from rest_framework.test import APIClient

    from .conftest import PW

    body = {"full_name": "يوسف", "email": "new@x.test", "password": PW}
    r = APIClient().post("/api/v1/auth/register", body, format="json")
    assert r.status_code == 400 and r.json()["fields"]["gender"] == ["اختر: ذكر أو أنثى."]
    assert APIClient().post("/api/v1/auth/register", {**body, "gender": "x"}, format="json").status_code == 400
    r = APIClient().post("/api/v1/auth/register", {**body, "gender": "female"}, format="json")
    assert r.status_code == 201 and User.objects.get(email="new@x.test").gender == "female"
    assert r.json()["user"]["display_name"] == "يوسف"                       # a student: never a title


def test_teacher_invitation_asks_for_title(world):
    from rest_framework.test import APIClient

    from apps.accounts.models import Invitation

    from .conftest import PW

    _, code = Invitation.issue(purpose=Invitation.Purpose.TEACHER_ACCOUNT, created_by=world.admin)
    body = {"code": code, "full_name": "الأستاذة هدى", "email": "huda2@x.test", "password": PW}
    r = APIClient().post("/api/v1/auth/invitations/accept", body, format="json")
    assert r.status_code == 400 and r.json()["fields"]["gender"]
    assert APIClient().post("/api/v1/auth/invitations/accept", {**body, "gender": "female"}, format="json").status_code == 201
    u = User.objects.get(email="huda2@x.test")
    assert u.full_name == "هدى" and u.gender == "female" and u.display_name == "الأستاذة هدى"
