"""Proposed Quranic entries for «الأذكار والأدعية» — REFERENCES ONLY (surah, first ayah, last ayah), whole ayahs.

The Arabic text is never written here: `seed_quran()` copies it from the verified Quran text imported from Tanzil
(apps.quran, the active source). Each entry is created «بانتظار المراجعة» (origin `quran_reference`): an administrator
with `adhkar.approve` checks the reference and its category before anything is shown or sent. A reference that does
not exist in the verified text (wrong ayah number) is skipped and reported, never guessed.

Hadith-based adhkar (morning, evening, sleep, waking, prophetic duas) are NOT seeded: their text must be entered by an
administrator from the cited collection (number + Sahih/Hasan grading), or imported from a licensed, verified dataset.
"""
from __future__ import annotations

# category → [(surah, ayah_from, ayah_to), …]
QURAN_REFERENCES: dict[str, list[tuple[int, int, int]]] = {
    "quran_dua": [
        (1, 6, 7), (2, 127, 128), (2, 201, 201), (2, 250, 250), (2, 286, 286), (3, 8, 9), (3, 16, 16), (3, 38, 38),
        (3, 53, 53), (3, 147, 147), (3, 191, 194), (7, 23, 23), (7, 47, 47), (7, 126, 126), (7, 151, 151),
        (10, 85, 86), (11, 47, 47), (12, 101, 101), (14, 40, 41), (17, 24, 24), (17, 80, 80), (18, 10, 10),
        (20, 25, 28), (20, 114, 114), (21, 83, 83), (21, 87, 87), (21, 89, 89), (23, 29, 29), (23, 97, 98),
        (23, 109, 109), (23, 118, 118), (25, 65, 66), (25, 74, 74), (26, 83, 85), (26, 169, 169), (27, 19, 19),
        (28, 16, 16), (28, 21, 21), (28, 24, 24), (29, 30, 30), (37, 100, 100), (40, 7, 9), (46, 15, 15),
        (54, 10, 10), (59, 10, 10), (66, 8, 8), (66, 11, 11), (71, 28, 28),
    ],
    "istighfar": [
        (3, 135, 135), (4, 110, 110), (8, 33, 33), (11, 3, 3), (39, 53, 53), (51, 18, 18), (71, 10, 12), (110, 1, 3),
    ],
    "tasbih": [(30, 17, 18), (37, 180, 182), (56, 96, 96), (87, 1, 1)],
    "tahmid": [(1, 2, 2), (6, 1, 1), (10, 10, 10), (18, 1, 1), (27, 59, 59), (34, 1, 1), (35, 1, 1)],
    "takbir": [(17, 111, 111), (74, 3, 3)],
    "salawat": [(33, 56, 56)],
    "dhikr": [
        (2, 152, 152), (2, 255, 255), (3, 173, 173), (7, 205, 205), (9, 129, 129), (13, 28, 28), (29, 45, 45),
        (33, 41, 42), (59, 22, 24), (62, 10, 10), (76, 25, 26), (112, 1, 4), (113, 1, 5), (114, 1, 6),
    ],
    "quran_motivation": [
        (2, 121, 121), (10, 57, 57), (17, 9, 9), (17, 82, 82), (29, 49, 49), (35, 29, 30), (38, 29, 29),
        (39, 23, 23), (44, 58, 58), (47, 24, 24), (54, 17, 17), (59, 21, 21), (73, 4, 4), (75, 16, 19),
    ],
}

ARABIC_DIGITS = str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩")


def quran_text(surah: int, ayah_from: int, ayah_to: int):
    """(text, source) from the active verified Quran text, each ayah followed by its number ﴿n﴾; None if the active
    source does not have every ayah of the range (wrong reference, or no verified text imported)."""
    from apps.quran.models import Ayah, QuranSource

    src = QuranSource.objects.filter(is_active=True).first()
    if src is None:
        return None
    ayahs = list(Ayah.objects.filter(source=src, surah__number=surah, number__gte=ayah_from, number__lte=ayah_to).order_by("number"))
    if len(ayahs) != ayah_to - ayah_from + 1:
        return None
    return " ".join(f"{a.text} ﴿{str(a.number).translate(ARABIC_DIGITS)}﴾" for a in ayahs), src


def seed_quran(actor=None) -> dict:
    """Create the proposed Quranic entries that do not exist yet (idempotent), pending review."""
    from .models import Dhikr

    out = {"created": 0, "existing": 0, "missing": []}
    for category, refs in QURAN_REFERENCES.items():
        for s, a, b in refs:
            if Dhikr.objects.filter(source_type="quran", surah=s, ayah_from=a, ayah_to=b).exists():
                out["existing"] += 1
                continue
            got = quran_text(s, a, b)
            if got is None:
                out["missing"].append(f"{s}:{a}-{b}")
                continue
            text, src = got
            Dhikr.objects.create(category=category, source_type="quran", text=text, surah=s, ayah_from=a, ayah_to=b, quran_source=src,
                                 status=Dhikr.Status.PENDING, origin="quran_reference", created_by=actor)
            out["created"] += 1
    return out
