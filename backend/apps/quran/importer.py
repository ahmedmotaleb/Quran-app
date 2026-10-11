"""
Import a Tanzil text file ("sura|aya|text" per line, '#' comment lines with the license notice).
Validation happens before anything is written: every surah must have exactly the Hafs ayah count,
no duplicates, no gaps. Text is stored byte-for-byte as supplied (after stripping the line ending).
"""
from __future__ import annotations

import hashlib
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass

from django.db import transaction

from .models import HAFS_AYAH_COUNTS, Ayah, QuranSource, Surah

_DIACRITICS = re.compile(r"[ؐ-ًؚ-ٰٟۖ-ۭـ]")


class ImportErrorList(Exception):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors[:10]))
        self.errors = errors


@dataclass
class Parsed:
    ayahs: dict[tuple[int, int], str]
    notice: str
    sha256: str


def search_form(text: str) -> str:
    return _DIACRITICS.sub("", text).replace("ٱ", "ا")


def parse_tanzil(raw: bytes, counts=HAFS_AYAH_COUNTS) -> Parsed:
    sha = hashlib.sha256(raw).hexdigest()
    errors: list[str] = []
    ayahs: dict[tuple[int, int], str] = {}
    notice_lines: list[str] = []
    for lineno, line in enumerate(raw.decode("utf-8-sig").splitlines(), 1):
        if not line.strip():
            continue
        if line.startswith("#"):
            notice_lines.append(line.lstrip("# ").rstrip())
            continue
        parts = line.split("|", 2)
        if len(parts) != 3 or not parts[0].isdigit() or not parts[1].isdigit() or not parts[2].strip():
            errors.append(f"line {lineno}: malformed")
            continue
        key = (int(parts[0]), int(parts[1]))
        if key in ayahs:
            errors.append(f"line {lineno}: duplicate {key[0]}:{key[1]}")
        ayahs[key] = parts[2]
    for s, n in enumerate(counts, 1):
        have = sorted(a for (ss, a) in ayahs if ss == s)
        if have != list(range(1, n + 1)):
            errors.append(f"surah {s}: expected ayahs 1..{n}, found {len(have)}")
    extra = [k for k in ayahs if not (1 <= k[0] <= len(counts))]
    if extra:
        errors.append(f"{len(extra)} ayahs outside surah range")
    if errors:
        raise ImportErrorList(errors)
    return Parsed(ayahs=ayahs, notice="\n".join(notice_lines), sha256=sha)


def parse_metadata(xml_bytes: bytes | None) -> dict[int, dict]:
    """Optional Tanzil quran-data.xml: surah names and revelation type."""
    if not xml_bytes:
        return {}
    root = ET.fromstring(xml_bytes)
    out = {}
    for s in root.iter("sura"):
        out[int(s.get("index"))] = {"name_ar": s.get("name", ""), "name_en": s.get("tname", ""), "revelation": s.get("type", "")}
    return out


@transaction.atomic
def import_source(*, parsed: Parsed, slug: str, name: str, edition: str, version: str, source_url: str,
                  license_name: str, meta: dict[int, dict], activate: bool, counts=HAFS_AYAH_COUNTS) -> QuranSource:
    if QuranSource.objects.filter(slug=slug).exists():
        raise ImportErrorList([f"source {slug!r} already exists; use a new slug for a new version"])
    if activate:
        QuranSource.objects.filter(is_active=True).update(is_active=False)
    src = QuranSource.objects.create(slug=slug, name=name, edition=edition, version=version, source_url=source_url,
                                     license_name=license_name, attribution=parsed.notice, sha256=parsed.sha256, is_active=activate)
    surahs = {}
    for n, cnt in enumerate(counts, 1):
        m = meta.get(n, {})
        surahs[n] = Surah.objects.create(source=src, number=n, ayah_count=cnt, name_ar=m.get("name_ar", ""),
                                         name_en=m.get("name_en", ""), revelation=m.get("revelation", ""))
    Ayah.objects.bulk_create(
        [Ayah(source=src, surah=surahs[s], number=a, text=t, search_text=search_form(t)) for (s, a), t in sorted(parsed.ayahs.items())],
        batch_size=1000,
    )
    return src


def verify_source(src: QuranSource, raw: bytes) -> list[str]:
    """Re-read the original file and compare every stored verse. Returns a list of differences."""
    parsed = parse_tanzil(raw)
    problems = []
    if parsed.sha256 != src.sha256:
        problems.append("file checksum differs from the imported version")
    stored = {(a.surah.number, a.number): a.text for a in Ayah.objects.filter(source=src).select_related("surah")}
    for key, text in parsed.ayahs.items():
        if stored.get(key) != text:
            problems.append(f"{key[0]}:{key[1]} differs or is missing")
    if len(stored) != len(parsed.ayahs):
        problems.append(f"stored {len(stored)} ayahs, file has {len(parsed.ayahs)}")
    return problems
