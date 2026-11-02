"""The ten canonical Qira'at and the two primary narrators (رواة) of each, as taught in al-Shāṭibiyyah (the seven) and
al-Durrah al-Muḍiyyah (the three), in the classical order. This is religious reference data: it is seeded by
migration 0015 and must not be edited casually. The codes are the stable identities; the Arabic text is display only.

Checked against the standard lists (the readers and their narrators): نافع (قالون، ورش)، ابن كثير (البزي، قنبل)،
أبو عمرو (الدوري، السوسي)، ابن عامر (هشام، ابن ذكوان)، عاصم (شعبة، حفص)، حمزة (خلف، خلاد)، الكسائي (أبو الحارث،
الدوري)، أبو جعفر (ابن وردان، ابن جماز)، يعقوب (رويس، روح)، خلف العاشر (إسحاق، إدريس).
"""
from __future__ import annotations

# (qiraah code, Arabic name, [(riwayah code, Arabic name, narrator), …]) — order = classical order.
CANON: tuple[tuple[str, str, tuple[tuple[str, str, str], ...]], ...] = (
    ("nafi", "نافع المدني", (("qalun", "قالون عن نافع", "قالون"), ("warsh", "ورش عن نافع", "ورش"))),
    ("ibn_kathir", "ابن كثير المكي", (("bazzi", "البزي عن ابن كثير", "البزي"), ("qunbul", "قنبل عن ابن كثير", "قنبل"))),
    ("abu_amr", "أبو عمرو البصري", (("duri_abu_amr", "الدوري عن أبي عمرو", "الدوري"), ("susi", "السوسي عن أبي عمرو", "السوسي"))),
    ("ibn_amir", "ابن عامر الشامي", (("hisham", "هشام عن ابن عامر", "هشام"), ("ibn_dhakwan", "ابن ذكوان عن ابن عامر", "ابن ذكوان"))),
    ("asim", "عاصم الكوفي", (("shubah", "شعبة عن عاصم", "شعبة"), ("hafs", "حفص عن عاصم", "حفص"))),
    ("hamzah", "حمزة الكوفي", (("khalaf_hamzah", "خلف عن حمزة", "خلف"), ("khallad", "خلاد عن حمزة", "خلاد"))),
    ("kisai", "الكسائي", (("abu_harith", "أبو الحارث عن الكسائي", "أبو الحارث"), ("duri_kisai", "الدوري عن الكسائي", "الدوري"))),
    ("abu_jafar", "أبو جعفر المدني", (("ibn_wardan", "ابن وردان عن أبي جعفر", "ابن وردان"), ("ibn_jammaz", "ابن جماز عن أبي جعفر", "ابن جماز"))),
    ("yaqub", "يعقوب الحضرمي", (("ruways", "رويس عن يعقوب", "رويس"), ("rawh", "روح عن يعقوب", "روح"))),
    ("khalaf", "خلف العاشر", (("ishaq", "إسحاق عن خلف", "إسحاق"), ("idris", "إدريس عن خلف", "إدريس"))),
)

RIWAYAH_QIRAAH = {r: q for q, _, rs in CANON for r, _, _ in rs}


def ensure_canon(Qiraah=None, Riwayah=None) -> None:
    """Create/refresh the reference rows (migration 0015; again after a dev/test `flush`). Idempotent."""
    if Qiraah is None:
        from .models import Qiraah, Riwayah
    for qi, (qcode, qname, rs) in enumerate(CANON, 1):
        q, _ = Qiraah.objects.update_or_create(code=qcode, defaults={"name_ar": qname, "order": qi})
        for ri, (rcode, rname, narrator) in enumerate(rs, 1):
            Riwayah.objects.update_or_create(code=rcode, defaults={"qiraah": q, "name_ar": rname, "narrator_ar": narrator, "order": ri})


def parse_selection(raw) -> list[str]:
    """A teacher's selection → canonical riwayah codes (in canonical order). Accepts codes, or
    {"qiraah": …, "riwayah": …} pairs whose qiraah must be the riwayah's own. Raises ValueError (Arabic) otherwise."""
    if not isinstance(raw, list):
        raise ValueError("أرسل قائمة بالروايات المختارة.")
    codes: list[str] = []
    for item in raw:
        if isinstance(item, dict):
            r, q = item.get("riwayah"), item.get("qiraah")
            if not isinstance(r, str) or r not in RIWAYAH_QIRAAH:
                raise ValueError("رواية غير معروفة.")
            if q is not None and q != RIWAYAH_QIRAAH[r]:
                raise ValueError("الرواية لا تتبع هذه القراءة.")
        elif isinstance(item, str) and item in RIWAYAH_QIRAAH:
            r = item
        else:
            raise ValueError("رواية غير معروفة.")
        if r in codes:
            raise ValueError("كُررت رواية في الاختيار.")
        codes.append(r)
    order = [r for _, _, rs in CANON for r, _, _ in rs]
    return sorted(codes, key=order.index)
