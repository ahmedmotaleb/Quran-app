"""
Import validation. The fixture uses obvious placeholder strings (not Quran text) in Tanzil's
"sura|aya|text" format, so the tests never ship generated or imitation verses.
"""
import pytest

from apps.quran.importer import ImportErrorList, import_source, parse_tanzil, verify_source
from apps.quran.models import HAFS_AYAH_COUNTS, Ayah

from .conftest import client_for


def fixture_file(mutate=None) -> bytes:
    lines = [f"{s}|{a}|PLACEHOLDER-{s}-{a}" for s, n in enumerate(HAFS_AYAH_COUNTS, 1) for a in range(1, n + 1)]
    if mutate:
        lines = mutate(lines)
    return ("\n".join(lines) + "\n# Test fixture notice\n").encode()


def test_counts_table_is_complete():
    assert len(HAFS_AYAH_COUNTS) == 114 and sum(HAFS_AYAH_COUNTS) == 6236


def test_rejects_missing_duplicate_and_malformed():
    with pytest.raises(ImportErrorList) as e:
        parse_tanzil(fixture_file(lambda ls: ls[:-1]))  # last ayah of surah 114 missing
    assert any("surah 114" in x for x in e.value.errors)
    with pytest.raises(ImportErrorList) as e:
        parse_tanzil(fixture_file(lambda ls: ls + ["1|1|DUP"]))
    assert any("duplicate 1:1" in x for x in e.value.errors)
    with pytest.raises(ImportErrorList):
        parse_tanzil(fixture_file(lambda ls: ls + ["not a verse line"]))


@pytest.mark.django_db
def test_import_verify_and_serve_verbatim(world):
    raw = fixture_file()
    src = import_source(parsed=parse_tanzil(raw), slug="test-src", name="Test", edition="Fixture", version="0", source_url="",
                        license_name="test", meta={}, activate=True)
    assert Ayah.objects.filter(source=src).count() == 6236
    assert verify_source(src, raw) == []
    Ayah.objects.filter(source=src, surah__number=1, number=1).update(text="ALTERED")
    assert any("1:1" in p for p in verify_source(src, raw))  # tampering is detected
    r = client_for(world.s1).get("/api/v1/quran/surahs/67?from=1&to=3").json()
    assert [a["text"] for a in r["ayahs"]] == ["PLACEHOLDER-67-1", "PLACEHOLDER-67-2", "PLACEHOLDER-67-3"]
    assert client_for(world.s1).get("/api/v1/quran/source").json()["attribution"] == "Test fixture notice"


@pytest.mark.django_db
def test_no_active_source_returns_clear_error(world):
    r = client_for(world.s1).get("/api/v1/quran/surahs")
    assert r.status_code == 503 and r.json()["code"] == "quran_unavailable"


@pytest.mark.django_db
def test_import_command_end_to_end(tmp_path):
    # Runs the management command exactly as the Ops workflow does (argument parsing included).
    from django.core.management import call_command

    from apps.quran.models import QuranSource

    f = tmp_path / "quran.txt"
    f.write_bytes(fixture_file())
    call_command("import_quran", str(f), "--source-version", "1.1", "--activate")
    src = QuranSource.objects.get(slug="tanzil-uthmani")
    assert src.is_active and src.version == "1.1"
    call_command("import_quran", str(f), "--verify")
