"""Qira'at qualifications: the ten canonical Qira'at with two Riwayat each, the teacher's selection (validated, waits
for the admin), admin confirm/edit (audited), learners see confirmed Riwayat only and can filter by one."""
import pytest
from django.utils import timezone

from apps.accounts.models import Qiraah, Riwayah, TeacherProfile, TeacherRiwayah
from apps.accounts.qiraat import CANON, RIWAYAH_QIRAAH, parse_selection
from apps.core.models import AuditEvent

from .conftest import client_for
from .test_admins import staff

pytestmark = pytest.mark.django_db
EXPECTED = {
    "نافع المدني": ["قالون عن نافع", "ورش عن نافع"], "ابن كثير المكي": ["البزي عن ابن كثير", "قنبل عن ابن كثير"],
    "أبو عمرو البصري": ["الدوري عن أبي عمرو", "السوسي عن أبي عمرو"], "ابن عامر الشامي": ["هشام عن ابن عامر", "ابن ذكوان عن ابن عامر"],
    "عاصم الكوفي": ["شعبة عن عاصم", "حفص عن عاصم"], "حمزة الكوفي": ["خلف عن حمزة", "خلاد عن حمزة"],
    "الكسائي": ["أبو الحارث عن الكسائي", "الدوري عن الكسائي"], "أبو جعفر المدني": ["ابن وردان عن أبي جعفر", "ابن جماز عن أبي جعفر"],
    "يعقوب الحضرمي": ["رويس عن يعقوب", "روح عن يعقوب"], "خلف العاشر": ["إسحاق عن خلف", "إدريس عن خلف"],
}
MINE = "/api/v1/teacher/riwayat"


@pytest.fixture(autouse=True)
def _canon(db):
    """Reference rows come from migration 0015; transactional tests elsewhere in the suite empty every table."""
    from apps.accounts.qiraat import ensure_canon

    ensure_canon()


def test_ten_qiraat_twenty_riwayat_seeded_exactly(world):
    assert Qiraah.objects.count() == 10 and Riwayah.objects.count() == 20
    got = {q.name_ar: [r.name_ar for r in q.riwayat.all()] for q in Qiraah.objects.prefetch_related("riwayat")}
    assert got == EXPECTED
    assert [q.code for q in Qiraah.objects.all()] == [c for c, _, _ in CANON]           # classical order
    for q, _, rs in CANON:
        assert {r.code for r in Riwayah.objects.filter(qiraah__code=q)} == {r for r, _, _ in rs}
    r = client_for(world.s1).get("/api/v1/qiraat").json()
    assert len(r) == 10 and sum(len(q["riwayat"]) for q in r) == 20
    assert r[4]["code"] == "asim" and [x["code"] for x in r[4]["riwayat"]] == ["shubah", "hafs"]


def test_parse_rejects_text_unknown_duplicate_and_wrong_qiraah():
    assert parse_selection(["hafs", "warsh"]) == ["warsh", "hafs"]                      # canonical order
    assert parse_selection([{"qiraah": "asim", "riwayah": "hafs"}]) == ["hafs"]
    for bad in (["حفص عن عاصم"], ["nope"], ["hafs", "hafs"], [{"qiraah": "nafi", "riwayah": "hafs"}], "hafs", [3]):
        with pytest.raises(ValueError):
            parse_selection(bad)
    assert len(RIWAYAH_QIRAAH) == 20


def test_teacher_selects_one_then_several_waiting_for_admin(world):
    t = client_for(world.t1)
    assert t.get(MINE).json() == {"riwayat": []}                                        # existing teacher: nothing assumed
    r = t.put(MINE, {"riwayat": ["hafs"]}, format="json")
    assert r.status_code == 200 and r.json()["riwayat"] == [
        {"code": "hafs", "name": "حفص عن عاصم", "qiraah": "asim", "qiraah_name": "عاصم الكوفي", "verified": False}]
    r = t.put(MINE, {"riwayat": ["hafs", "shubah", "warsh"]}, format="json")
    assert [x["code"] for x in r.json()["riwayat"]] == ["warsh", "shubah", "hafs"]
    assert TeacherRiwayah.objects.filter(teacher=world.t1).count() == 3
    assert AuditEvent.objects.filter(action="teacher.riwayat_updated").count() == 2
    # Not shown to learners until confirmed.
    d = client_for(world.s1).get(f"/api/v1/teachers/{world.t1.pk}").json()
    assert d["riwayat_qualifications"] == []


@pytest.mark.parametrize("body,msg", [({"riwayat": []}, "واحدة على الأقل"), ({"riwayat": ["hafs", "hafs"]}, "كُررت"),
                                      ({"riwayat": ["xyz"]}, "غير معروفة"), ({"riwayat": "hafs"}, "قائمة"),
                                      ({"riwayat": [{"qiraah": "nafi", "riwayah": "hafs"}]}, "لا تتبع"), ({}, "قائمة")])
def test_teacher_invalid_selection_refused(world, body, msg):
    r = client_for(world.t1).put(MINE, body, format="json")
    assert r.status_code == 400 and msg in r.json()["fields"]["riwayat"][0]
    assert not TeacherRiwayah.objects.exists()


def test_only_teachers_use_the_teacher_endpoint(world):
    assert client_for(world.s1).put(MINE, {"riwayat": ["hafs"]}, format="json").status_code == 403
    assert client_for(world.p1).get(MINE).status_code == 403


def test_teacher_removal_applies_and_confirmed_stay_confirmed(world):
    TeacherRiwayah.objects.create(teacher=world.t1, riwayah=Riwayah.objects.get(code="hafs"), verified_at=timezone.now())
    r = client_for(world.t1).put(MINE, {"riwayat": ["hafs", "qalun"]}, format="json").json()["riwayat"]
    assert {(x["code"], x["verified"]) for x in r} == {("hafs", True), ("qalun", False)}  # an addition waits
    r = client_for(world.t1).put(MINE, {"riwayat": ["qalun"]}, format="json").json()["riwayat"]
    assert [x["code"] for x in r] == ["qalun"]                                         # a removal is immediate


def test_admin_views_edits_confirms_with_audit_and_permissions(world):
    client_for(world.t1).put(MINE, {"riwayat": ["hafs", "warsh"]}, format="json")
    a = client_for(world.admin)
    url = f"/api/v1/admin/teachers/{world.t1.pk}/riwayat"
    assert [(x["code"], x["verified"]) for x in a.get(url).json()["riwayat"]] == [("warsh", False), ("hafs", False)]
    rec = a.get(f"/api/v1/admin/users/{world.t1.pk}").json()
    assert [x["code"] for x in rec["riwayat"]] == ["warsh", "hafs"]
    r = a.put(url, {"riwayat": ["hafs", "shubah"]}, format="json")                      # edit + confirm
    assert [(x["code"], x["verified"]) for x in r.json()["riwayat"]] == [("shubah", True), ("hafs", True)]
    e = AuditEvent.objects.get(action="admin.teacher_riwayat")
    assert e.data["before"] == ["warsh?", "hafs?"] and e.data["after"] == ["shubah", "hafs"]
    assert a.put(url, {"riwayat": ["bogus"]}, format="json").status_code == 400
    assert a.put(f"/api/v1/admin/teachers/{world.s1.pk}/riwayat", {"riwayat": ["hafs"]}, format="json").status_code == 404
    support = staff("sup@x.test", preset="support")                                     # may view teachers, not approve
    assert client_for(support).get(url).status_code == 200
    assert client_for(support).put(url, {"riwayat": []}, format="json").status_code == 403
    assert client_for(staff("cnt@x.test", preset="content")).get(url).status_code == 403
    assert client_for(world.t1).put(url, {"riwayat": ["hafs"]}, format="json").status_code == 403


def test_approval_confirms_what_the_teacher_chose(world):
    TeacherProfile.objects.filter(user=world.t2).update(approved_at=None)
    client_for(world.t2).put(MINE, {"riwayat": ["warsh"]}, format="json")
    r = client_for(world.admin).post(f"/api/v1/admin/teachers/{world.t2.pk}/approval", {"approved": True}, format="json")
    assert r.status_code == 200 and r.json()["riwayat"][0]["verified"] is True
    assert AuditEvent.objects.get(action="admin.teacher_approval").data["riwayat_confirmed"] == ["warsh"]


def test_students_see_confirmed_and_filter_by_riwayah(world):
    a = client_for(world.admin)
    a.put(f"/api/v1/admin/teachers/{world.t1.pk}/riwayat", {"riwayat": ["hafs", "shubah"]}, format="json")
    a.put(f"/api/v1/admin/teachers/{world.t2.pk}/riwayat", {"riwayat": ["warsh"]}, format="json")
    TeacherRiwayah.objects.create(teacher=world.t2, riwayah=Riwayah.objects.get(code="hafs"))  # not confirmed
    s = client_for(world.s1)
    rows = {x["id"]: x for x in s.get("/api/v1/teachers").json()["results"]}
    assert [x["name"] for x in rows[world.t1.pk]["riwayat_qualifications"]] == ["شعبة عن عاصم", "حفص عن عاصم"]
    assert rows[world.t1.pk]["riwayat_qualifications"][0] == {"code": "shubah", "name": "شعبة عن عاصم", "qiraah": "asim", "qiraah_name": "عاصم الكوفي"}
    assert [x["code"] for x in rows[world.t2.pk]["riwayat_qualifications"]] == ["warsh"]  # the unconfirmed hafs is hidden
    ids = lambda q: [x["id"] for x in s.get(f"/api/v1/teachers?riwayah={q}").json()["results"]]  # noqa: E731
    assert ids("warsh") == [world.t2.pk]
    assert ids("hafs") == [world.t1.pk]                                                 # t2's hafs is unconfirmed
    assert ids("qalun") == []
    assert s.get("/api/v1/teachers?riwayah=bad").status_code == 400
    assert s.get(f"/api/v1/teachers/{world.t1.pk}").json()["riwayat_qualifications"][1]["code"] == "hafs"


def test_existing_teachers_without_qualifications_still_listed(world):
    rows = client_for(world.s1).get("/api/v1/teachers").json()["results"]
    assert {x["id"] for x in rows} == {world.t1.pk, world.t2.pk} and all(x["riwayat_qualifications"] == [] for x in rows)
    assert client_for(world.admin).get(f"/api/v1/admin/users/{world.t1.pk}").json()["riwayat"] == []
    assert client_for(world.admin).get(f"/api/v1/admin/users/{world.s1.pk}").json()["riwayat"] is None
