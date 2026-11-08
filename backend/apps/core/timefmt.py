"""User-facing dates and times in messages (notifications, emails): 12-hour clock with «صباحًا» / «مساءً» and
Arabic-Indic digits, in the recipient's IANA zone (Africa/Cairo by default, DST from the IANA database; never a
fixed offset). Timestamps stay UTC in the database; only the text is local.

    clock(14, 30) == "٢:٣٠ مساءً"        clock(9, 0) == "٩:٠٠ صباحًا"
    when(dt, "Africa/Cairo") == "الأحد ٨ نوفمبر، ٢:٣٠ مساءً"
"""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULT_ZONE = "Africa/Cairo"
AM, PM = "صباحًا", "مساءً"
_DIGITS = str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩")
WEEKDAYS = ["الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد"]  # Python order (0 = Monday)
MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"]


def ar_digits(v) -> str:
    return str(v).translate(_DIGITS)


def zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or DEFAULT_ZONE)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo(DEFAULT_ZONE)


def clock(hour: int, minute: int = 0) -> str:
    h = hour % 24
    return f"{ar_digits(h % 12 or 12)}:{ar_digits(f'{minute:02d}')} {AM if h < 12 else PM}"


def local(dt: datetime, tz: str | None) -> datetime:
    return dt.astimezone(zone(tz))


def time_of(dt: datetime, tz: str | None) -> str:
    x = local(dt, tz)
    return clock(x.hour, x.minute)


def day_of(dt: datetime, tz: str | None) -> str:
    x = local(dt, tz)
    return f"{WEEKDAYS[x.weekday()]} {ar_digits(x.day)} {MONTHS[x.month - 1]}"


def when(dt: datetime, tz: str | None) -> str:
    """«الأحد ٨ نوفمبر، ٢:٣٠ مساءً» in that zone."""
    return f"{day_of(dt, tz)}، {time_of(dt, tz)}"
