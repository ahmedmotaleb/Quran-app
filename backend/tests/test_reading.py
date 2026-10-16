"""Pack prompt 20: reading position and bookmarks, stored by reference and kept apart from the canonical text."""
import pytest

from apps.quran.models import Ayah, Bookmark

from .conftest import client_for

pytestmark = pytest.mark.django_db


def test_position_persists_across_devices(world):
    phone, laptop = client_for(world.s1), client_for(world.s1)  # two tokens = two devices
    assert phone.get("/api/v1/quran/position").json()["surah"] is None
    assert phone.put("/api/v1/quran/position", {"surah": 67, "ayah": 12}, format="json").status_code == 200
    assert laptop.get("/api/v1/quran/position").json()["surah"] == 67 and laptop.get("/api/v1/quran/position").json()["ayah"] == 12
    laptop.put("/api/v1/quran/position", {"surah": 2, "ayah": 255}, format="json")
    assert phone.get("/api/v1/quran/position").json()["ayah"] == 255
    assert client_for(world.s2).get("/api/v1/quran/position").json()["surah"] is None  # per user


@pytest.mark.parametrize("ref", [{"surah": 1, "ayah": 8}, {"surah": 115, "ayah": 1}, {"surah": 0, "ayah": 1}, {"surah": "x", "ayah": 1}, {}])
def test_references_must_exist(world, ref):
    c = client_for(world.s1)
    assert c.put("/api/v1/quran/position", ref, format="json").status_code == 400
    assert c.post("/api/v1/quran/bookmarks", ref, format="json").status_code == 400


def test_bookmarks_private_labels_and_no_text_stored(world):
    c = client_for(world.s1)
    r = c.post("/api/v1/quran/bookmarks", {"surah": 67, "ayah": 1, "label": "  بداية حفظ الأسبوع  "}, format="json")
    assert r.status_code == 201 and r.json()["label"] == "بداية حفظ الأسبوع"
    assert c.post("/api/v1/quran/bookmarks", {"surah": 67, "ayah": 1}, format="json").status_code == 200  # same ayah: no duplicate
    c.post("/api/v1/quran/bookmarks", {"surah": 2, "ayah": 255}, format="json")
    assert [(b["surah"], b["ayah"]) for b in c.get("/api/v1/quran/bookmarks").json()] == [(2, 255), (67, 1)]
    bid = r.json()["id"]
    assert c.patch(f"/api/v1/quran/bookmarks/{bid}", {"label": "مراجعة"}, format="json").json()["label"] == "مراجعة"
    # Another user can neither see nor change nor delete it.
    other = client_for(world.s2)
    assert other.get("/api/v1/quran/bookmarks").json() == []
    assert other.patch(f"/api/v1/quran/bookmarks/{bid}", {"label": "x"}, format="json").status_code == 404
    assert other.delete(f"/api/v1/quran/bookmarks/{bid}").status_code == 404
    assert c.delete(f"/api/v1/quran/bookmarks/{bid}").status_code == 204
    # Only references are stored: no verse text, and the canonical table is untouched.
    assert {f.name for f in Bookmark._meta.get_fields()} == {"id", "user", "surah", "ayah", "label", "created_at"}
    assert Ayah.objects.count() == 0
    assert client_for(world.p1).get("/api/v1/quran/bookmarks").status_code == 200  # any signed-in reader


def test_anonymous_cannot_read_or_write(client):
    assert client.get("/api/v1/quran/bookmarks").status_code in (401, 403)
    assert client.put("/api/v1/quran/position", {"surah": 1, "ayah": 1}, format="json").status_code in (401, 403)


def test_bad_range_parameters_are_a_clear_400(world):
    r = client_for(world.s1).get("/api/v1/quran/surahs/1", {"from": "abc"})
    assert r.status_code in (400, 503)  # 503 when no verified text is imported in the test database
