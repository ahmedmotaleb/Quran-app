"""Surah/ayah references for mistakes (and other pickers): one canonical index of all 114 surahs, and the backend
refuses an ayah that does not exist in its surah — on create and on edit. Names in the fixture are placeholders."""
import json
from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from apps.core.models import AuditEvent
from apps.learning.models import Correction
from apps.quran.importer import import_source, parse_tanzil
from apps.quran.models import HAFS_AYAH_COUNTS
from apps.quran.reference import ayah_count, surah_index, validate_ref

from .conftest import client_for
from .test_quran import fixture_file

pytestmark = pytest.mark.django_db
URL = "/api/v1/corrections"
KNOWN = {1: 7, 2: 286, 3: 200, 4: 176, 18: 110, 36: 83, 55: 78, 67: 30, 112: 4, 113: 5, 114: 6}


def imported(names=True):
    meta = {n: {"name_ar": f"اسم-{n}", "name_en": "", "revelation": ""} for n in range(1, 115)} if names else {}
    return import_source(parsed=parse_tanzil(fixture_file()), slug="t", name="T", edition="F", version="0", source_url="",
                         license_name="t", meta=meta, activate=True)


def add(user, student, **kw):
    body = {"student": student, "source": "task", "surah": 67, "ayah": 3, "category": "madd", **kw}
    return client_for(user).post(URL, body, format="json")


def test_every_surah_has_a_valid_range_in_mushaf_order():
    assert len(HAFS_AYAH_COUNTS) == 114 and sum(HAFS_AYAH_COUNTS) == 6236
    for n in range(1, 115):
        c = ayah_count(n)
        assert c and c >= 3
        assert validate_ref(n, 1) == (n, 1) and validate_ref(n, c) == (n, c)
    for n, c in KNOWN.items():
        assert ayah_count(n) == c
    assert ayah_count(0) is None and ayah_count(115) is None


def test_index_lists_all_114_with_names_from_the_verified_source(world):
    imported()
    r = client_for(world.t1).get("/api/v1/quran/index")
    assert r.status_code == 200
    d = r.json()
    assert d["verified"] is True and d["source"] == "t"
    assert [s["number"] for s in d["surahs"]] == list(range(1, 115))
    assert [s["ayah_count"] for s in d["surahs"]] == list(HAFS_AYAH_COUNTS)
    assert d["surahs"][1]["name_ar"] == "اسم-2"
    from rest_framework.test import APIClient

    assert APIClient().get("/api/v1/quran/index").status_code in (401, 403)


def test_index_still_has_counts_before_the_text_is_imported(world):
    d = client_for(world.t1).get("/api/v1/quran/index").json()
    assert len(d["surahs"]) == 114 and d["verified"] is False and d["surahs"][113] == {"number": 114, "name_ar": "", "ayah_count": 6}


@pytest.mark.parametrize("surah,ayah,field", [(1, 20, "ayah"), (112, 10, "ayah"), (114, 20, "ayah"), (115, 1, "surah"),
                                              (0, 1, "surah"), (2, 0, "ayah"), (2, 287, "ayah")])
def test_create_rejects_impossible_references(world, surah, ayah, field):
    imported()
    r = add(world.t1, world.s1.pk, surah=surah, ayah=ayah)
    assert r.status_code == 400 and field in r.json()["fields"], r.json()
    assert Correction.objects.count() == 0


def test_error_names_the_surah_and_its_range(world):
    imported()
    msg = add(world.t1, world.s1.pk, surah=1, ayah=20).json()["fields"]["ayah"]
    assert "اسم-1" in str(msg) and "7" in str(msg)


def test_create_any_valid_ayah_in_the_quran(world):
    for s, a in ((2, 255), (2, 286), (18, 110), (114, 6), (1, 7)):
        r = add(world.t1, world.s1.pk, surah=s, ayah=a)
        assert r.status_code == 201 and (r.json()["surah"], r.json()["ayah"]) == (s, a)


def test_edit_reference_validated_as_a_pair_and_audited(world):
    c = add(world.t1, world.s1.pk, surah=2, ayah=255).json()
    url = f"{URL}/{c['id']}"
    t = client_for(world.t1)
    r = t.patch(url, {"surah": 1}, format="json")                                # new surah without its ayah
    assert r.status_code == 400 and "ayah" in r.json()["fields"]
    assert t.patch(url, {"surah": 1, "ayah": 255}, format="json").status_code == 400  # ayah kept from al-Baqarah
    assert t.patch(url, {"ayah": 287}, format="json").status_code == 400
    assert t.patch(url, {"surah": 115, "ayah": 1}, format="json").status_code == 400
    assert (Correction.objects.get(pk=c["id"]).surah, Correction.objects.get(pk=c["id"]).ayah) == (2, 255)
    r = t.patch(url, {"surah": 112, "ayah": 4, "category": "makharij", "note": "تعديل"}, format="json")
    assert r.status_code == 200 and (r.json()["surah"], r.json()["ayah"], r.json()["category"]) == (112, 4, "makharij")
    assert t.patch(url, {"ayah": 3}, format="json").json()["ayah"] == 3               # same surah, ayah only
    e = AuditEvent.objects.filter(action="correction.updated").order_by("id")
    assert e.first().data["old_ref"] == "2:255" and e.first().data["new_ref"] == "112:4"
    assert client_for(world.t2).patch(url, {"surah": 1, "ayah": 1}, format="json").status_code in (403, 404)
    assert client_for(world.s1).patch(url, {"surah": 1, "ayah": 1}, format="json").status_code == 403


def test_existing_records_still_listed(world):
    """Records saved before this change (numbers only) keep rendering: the API returns the same numbers."""
    Correction.objects.create(student=world.s1, teacher=world.t1, source="task", surah=67, ayah=3, category="madd")
    rows = client_for(world.s1).get(URL).json()["results"]
    assert [(x["surah"], x["ayah"]) for x in rows] == [(67, 3)]


def test_check_command_verifies_index_and_saved_references(world):
    imported()
    out = StringIO()
    call_command("check_quran_reference", stdout=out)
    r = json.loads(out.getvalue())
    assert r["surahs"] == 114 and r["counts_match"] and r["names_present"] and r["invalid_references"]["corrections"] == 0
    Correction.objects.create(student=world.s1, teacher=world.t1, source="task", surah=1, ayah=9, category="madd")  # legacy bad row
    with pytest.raises(CommandError):
        call_command("check_quran_reference", stdout=StringIO())
    assert Correction.objects.filter(surah=1, ayah=9).exists()                       # reported, never deleted


def test_check_command_reports_missing_names(world):
    imported(names=False)
    with pytest.raises(CommandError, match="no Arabic name"):
        call_command("check_quran_reference", stdout=StringIO())
    assert surah_index()["verified"] is False
