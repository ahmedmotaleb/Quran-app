"""Canonical Quran references (surah 1–114, ayah within that surah) for everything that points at an ayah.

Single source of truth: the ayah counts are `HAFS_AYAH_COUNTS`, which the Tanzil import is rejected against, and the
surah names come from the active verified source (imported from Tanzil's quran-data.xml). No other list exists.
"""
from __future__ import annotations

from rest_framework import serializers

from .models import HAFS_AYAH_COUNTS, QuranSource, Surah


def ayah_count(surah: int) -> int | None:
    return HAFS_AYAH_COUNTS[surah - 1] if isinstance(surah, int) and 1 <= surah <= 114 else None


def surah_index() -> dict:
    """All 114 surahs in Mushaf order: number, Arabic name (from the verified source; "" if none is imported yet) and
    ayah count. `verified` says whether the stored source agrees with the canonical counts for every surah."""
    src = QuranSource.objects.filter(is_active=True).first()
    rows = {s.number: s for s in Surah.objects.filter(source=src)} if src else {}
    surahs = [{"number": i + 1, "name_ar": rows[i + 1].name_ar if i + 1 in rows else "", "ayah_count": n}
              for i, n in enumerate(HAFS_AYAH_COUNTS)]
    verified = bool(src) and len(rows) == 114 and all(rows[i + 1].ayah_count == n and rows[i + 1].name_ar
                                                      for i, n in enumerate(HAFS_AYAH_COUNTS))
    return {"source": src.slug if src else None, "verified": verified, "surahs": surahs}


def surah_name(surah: int) -> str:
    s = Surah.objects.filter(source__is_active=True, number=surah).values_list("name_ar", flat=True).first()
    return s or f"رقم {surah}"


def validate_ref(surah, ayah) -> tuple[int, int]:
    """(surah, ayah) if the ayah exists in that surah; otherwise a field error in Arabic (never saved)."""
    try:
        s, a = int(surah), int(ayah)
    except (TypeError, ValueError):
        raise serializers.ValidationError({"ayah": ["اختر السورة والآية."]}) from None
    n = ayah_count(s)
    if n is None:
        raise serializers.ValidationError({"surah": ["رقم السورة يجب أن يكون من 1 إلى 114."]})
    if not 1 <= a <= n:
        raise serializers.ValidationError({"ayah": [f"سورة {surah_name(s)} تحتوي {n} آية فقط؛ اختر آية من 1 إلى {n}."]})
    return s, a
