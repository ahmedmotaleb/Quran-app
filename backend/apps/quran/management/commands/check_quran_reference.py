"""Read-only: the 114-surah index pickers use is complete and agrees with the verified source.

Checks the active source has all 114 surahs with the canonical Hafs ayah counts and a name, optionally that the names
match Tanzil's quran-data.xml, and that no saved mistake, task or bookmark points at an ayah that does not exist.
Prints a JSON report (numbers only, no student data) and fails if anything disagrees.
"""
import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db.models import Q

from apps.quran.importer import parse_metadata
from apps.quran.models import HAFS_AYAH_COUNTS, QuranSource, Surah


def invalid_refs(qs, surah: str, *ayahs: str) -> int:
    bad = Q(**{f"{surah}__lt": 1}) | Q(**{f"{surah}__gt": 114})
    for i, n in enumerate(HAFS_AYAH_COUNTS):
        for a in ayahs:
            bad |= Q(**{surah: i + 1}) & (Q(**{f"{a}__lt": 1}) | Q(**{f"{a}__gt": n}))
    return qs.filter(bad).count()


class Command(BaseCommand):
    help = "Verify the 114-surah index (counts, names) and that stored references exist (read-only)."

    def add_arguments(self, p):
        p.add_argument("--metadata", type=Path, help="Tanzil quran-data.xml to compare the surah names with")

    def handle(self, metadata=None, **_):
        from apps.learning.models import Assignment, Correction
        from apps.quran.models import Bookmark, ReadingPosition

        src = QuranSource.objects.filter(is_active=True).first()
        rows = {s.number: s for s in Surah.objects.filter(source=src)} if src else {}
        problems = []
        if not src:
            problems.append("no active Quran source")
        for i, n in enumerate(HAFS_AYAH_COUNTS):
            s = rows.get(i + 1)
            if s is None:
                problems.append(f"surah {i + 1}: missing")
            elif s.ayah_count != n or s.ayahs.count() != n:
                problems.append(f"surah {i + 1}: {s.ayah_count} / {s.ayahs.count()} ayahs stored, canonical {n}")
            elif not s.name_ar:
                problems.append(f"surah {i + 1}: no Arabic name")
        meta_ok = None
        if metadata:
            meta = parse_metadata(metadata.read_bytes())
            diff = [n for n in range(1, 115) if n in rows and meta.get(n, {}).get("name_ar") != rows[n].name_ar]
            meta_ok = not diff and len(meta) == 114
            problems += [f"surah {n}: name differs from quran-data.xml" for n in diff]
        refs = {
            "corrections": invalid_refs(Correction.objects.all(), "surah", "ayah"),
            "assignments": invalid_refs(Assignment.objects.all(), "surah", "ayah_from", "ayah_to"),
            "bookmarks": invalid_refs(Bookmark.objects.all(), "surah", "ayah"),
            "reading_positions": invalid_refs(ReadingPosition.objects.all(), "surah", "ayah"),
        }
        problems += [f"{k}: {v} with an ayah outside its surah" for k, v in refs.items() if v]
        report = {"source": src.slug if src else None, "surahs": len(rows), "ayahs": sum(HAFS_AYAH_COUNTS),
                  "counts_match": not any("ayahs stored" in p or "missing" in p for p in problems),
                  "names_present": all(s.name_ar for s in rows.values()) and len(rows) == 114,
                  "names_match_metadata": meta_ok, "invalid_references": refs, "problems": problems[:20]}
        self.stdout.write(json.dumps(report, ensure_ascii=False))
        if problems:
            raise CommandError(f"{len(problems)} problem(s): " + "; ".join(problems[:5]))
