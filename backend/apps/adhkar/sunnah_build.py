"""Build data/sunnah_adhkar.json from the public-domain hadith dataset (github.com/fawazahmed0/hadith-api, Unlicense).

Run by a developer, not in production: `python -m apps.adhkar.sunnah_build <dir with ara-*.json>`.
Every text is COPIED from the narration in the dataset: the dhikr is the span between a start and an end marker,
located with diacritics ignored, and stored exactly as the source spells it, diacritics included. Nothing is typed.
- Bukhari and Muslim are graded صحيح.
- The Sunan need al-Albani's grade in the dataset to be Sahih or Hasan. Anything else is refused, and so is a
  marker that is not found.
Muslim uses the Fuad Abdul-Baqi number (the dataset's `arabicnumber`). The others use the standard number.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from .sunnah_refs import REFS

COLL = {  # dataset key → (Arabic title, sunnah.com slug)
    "bukhari": ("صحيح البخاري", "bukhari"), "muslim": ("صحيح مسلم", "muslim"), "abudawud": ("سنن أبي داود", "abudawud"),
    "tirmidhi": ("جامع الترمذي", "tirmidhi"), "nasai": ("سنن النسائي", "nasai"), "ibnmajah": ("سنن ابن ماجه", "ibnmajah"),
}
DIAC = re.compile(r"[ً-ٰٟـۖ-ۭ‎‏\"]")
NARRATOR = re.compile(r"(^| )(و?قال|حدث|اخبر|عن|زاد|يعني|رواه) ")
FOLD = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي"})


def norm_map(s: str) -> tuple[str, list[int]]:
    """Text without diacritics (letters folded) and, for each kept character, its index in the original."""
    out, idx = [], []
    for i, ch in enumerate(s):
        if DIAC.match(ch):
            continue
        if ch.isspace() or ch in "،,.؛:":
            if out and out[-1] == " ":
                continue
            ch = " "
        out.append(ch.translate(FOLD)); idx.append(i)
    return "".join(out), idx


def key(s: str) -> str:
    return norm_map(s)[0].strip()


def extract(text: str, start: str, end: str) -> str | None:
    n, idx = norm_map(text)
    a = n.find(key(start))
    if a < 0:
        return None
    e = n.find(key(end), a)
    if e < 0:
        return None
    e += len(key(end)) - 1
    raw = text[idx[a]: idx[e] + 1]
    # keep the diacritics that follow the last letter
    j = idx[e] + 1
    while j < len(text) and re.match(r"[ً-ٰٟ]", text[j]):
        raw += text[j]; j += 1
    return re.sub(r"\s+", " ", re.sub(r"[‎‏\"]", "", raw)).strip()


def grade(c: str, h: dict) -> tuple[str, str] | None:
    if c in ("bukhari", "muslim"):
        return "sahih", ""
    g = next((x["grade"] for x in h.get("grades", []) if x["name"] == "Al-Albani"), "")
    gl = g.lower()
    if "sahih" in gl and "da" not in gl:
        return "sahih", "الألباني"
    if "hasan" in gl and "da" not in gl:
        return "hasan", "الألباني"
    return None


def build(src: Path) -> tuple[list[dict], list[str]]:
    books = {c: json.loads((src / f"ara-{c}.json").read_text()) for c in {r["collection"] for r in REFS}}
    rows, errors = [], []
    for r in REFS:
        c, num = r["collection"], str(r["number"])
        field = "arabicnumber" if c == "muslim" else "hadithnumber"
        cands = [h for h in books[c]["hadiths"] if str(h.get(field, "")).split(".")[0] == num]
        got = None
        for h in cands:
            t = extract(h["text"], r["start"], r.get("end", r["start"]))
            if t and "\ufffd" not in t and not NARRATOR.search(key(t)):  # a narrator's words inside the span: try the next narration
                got = (h, t); break
        if not got:
            errors.append(f"{c} {num}: «{r['start']}» … «{r.get('end', '')}» not found"); continue
        g = grade(c, got[0])
        if not g:
            errors.append(f"{c} {num}: grade not sahih/hasan ({got[0].get('grades')})"); continue
        title, slug = COLL[c]
        rows.append({"category": r["category"], "time_of_day": r.get("time", "any"), "text": got[1], "hadith_collection": title,
                     "hadith_number": num, "grading": g[0], "graded_by": g[1], "repetition": r.get("repetition"),
                     "reference_url": f"https://sunnah.com/{slug}:{num}"})
    return rows, errors


if __name__ == "__main__":
    rows, errors = build(Path(sys.argv[1]))
    for e in errors:
        print("REFUSED", e)
    out = Path(__file__).parent / "data" / "sunnah_adhkar.json"
    out.write_text(json.dumps({"source": "github.com/fawazahmed0/hadith-api (Unlicense), text copied verbatim", "entries": rows},
                              ensure_ascii=False, indent=1) + "\n")
    print(len(rows), "entries →", out)
