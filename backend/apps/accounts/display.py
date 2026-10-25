"""How a person's name is shown (owner request, 25 October 2026): every teacher's name carries the Arabic title —
«الشيخ» for a man, «الأستاذة» for a woman — wherever it is shown or sent (screens, notifications, exports).

The title is presentation only: `full_name` is never changed and editable fields always carry the plain name. Titles
someone already typed into a teacher's name («الشيخ …», «الأستاذة …», «الشيخ …», «أ. …») are removed before the
correct one is added, so a title is never doubled. Students, parents and admin-only accounts are shown as they are.
A teacher whose gender is not set yet is shown with the plain name (never a guessed title).

The app has the same rule in src/lib/names.ts (formatTeacherName); keep the two in step.
"""
from __future__ import annotations

import re

TITLE = {"male": "الشيخ", "female": "الأستاذة"}
# Titles to remove from the start of a stored teacher name (repeated: «الشيخ الشيخ أحمد»).
_LEADING = re.compile(r"^\s*(?:(?:ال)?أستاذة?|(?:ال)?استاذة?|(?:ال)?شيخة?|أ\s*[./]|أ/)\s*", re.UNICODE)


def strip_title(name: str) -> str:
    n = (name or "").strip()
    while True:
        m = _LEADING.match(n)
        if not m or not n[m.end():].strip():
            return n
        n = n[m.end():].strip()


def teacher_name(full_name: str, gender: str) -> str:
    """«الشيخ أحمد محمد» / «الأستاذة مريم أحمد»; the stored name (unchanged) when the gender is not set."""
    t = TITLE.get(gender or "")
    return f"{t} {strip_title(full_name)}" if t else (full_name or "").strip()


def display_name(user) -> str:
    """The name to show for any account: teachers with their title, everyone else exactly as stored."""
    if user is None:
        return ""
    if getattr(user, "role", None) == "teacher" and getattr(user, "status", "") != "deleted":
        return teacher_name(user.full_name, getattr(user, "gender", ""))
    return user.full_name
