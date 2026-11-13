"""Scheduled adhkar reminders (the hourly maintenance job, `adhkar_reminders`) and shared helpers.

For each active account (student, teacher, parent or administrator) with an active phone device and «تفعيل الأذكار» on,
in the account's own IANA time zone (User.timezone, which follows the device; Africa/Cairo by default):
- morning / evening / sleep adhkar: once a day at the chosen hour, caught up later the same day (CATCH_UP hours) if a
  run was missed or the clock moved (DST, travel); only from entries of that time;
- periodic reminders: every 1, 2, 3 or 4 hours inside the chosen window (default every 2 hours, 08:00–22:00), from the
  general categories (+ Quranic / prophetic duas when those are on);
- never inside quiet hours; at most one adhkar notice per account per run;
- each slot (`morning:<date>`, `p:<date>:<hour>`) at most once per account — enforced by a unique row, so a repeated
  hour (DST fall-back) or two concurrent runs can never send twice;
- rotation: the entry this account has not received for the longest (never received first), so nothing repeats until
  the eligible entries have all been sent;
- only APPROVED and ENABLED entries. With none eligible, nothing is sent (never a placeholder).
Adhkar notices are separate from learning/administrative notices: turning adhkar off changes nothing else.
"""
from __future__ import annotations

from datetime import datetime, time, timedelta
from datetime import timezone as dt_timezone

from django.db import IntegrityError, transaction
from django.db.models import F, Max, OuterRef, Subquery
from django.utils import timezone

from apps.core.timefmt import zone

from .models import Delivery, Dhikr, Preferences

CATCH_UP = 3  # hours after the chosen time in which a missed morning/evening/sleep reminder is still sent
GENERAL = ["istighfar", "tasbih", "tahmid", "takbir", "salawat", "dhikr", "quran_motivation"]
TIMED = {"morning": Dhikr.Time.MORNING, "evening": Dhikr.Time.EVENING, "sleep": Dhikr.Time.SLEEP}
TITLE = {
    "morning": "الحلقة | أذكار الصباح", "evening": "الحلقة | أذكار المساء", "sleep": "الحلقة | أذكار النوم", "waking": "الحلقة | أذكار الاستيقاظ",
    "quran_dua": "الحلقة | دعاء قرآني", "sunnah_dua": "الحلقة | دعاء نبوي", "istighfar": "الحلقة | استغفار",
    "salawat": "الحلقة | الصلاة على النبي ﷺ", "quran_motivation": "الحلقة | فضل القرآن",
}
DIGITS = str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩")


def prefs_for(user) -> Preferences:
    return getattr(user, "adhkar_prefs", None) or Preferences(user=user)


def source_label(d: Dhikr) -> str:
    """«البقرة: ٢٠١» / «آل عمران: ١٩١–١٩٤» / «صحيح مسلم (٢٦٩١) · صحيح»."""
    if d.source_type == "quran":
        from apps.quran.models import Surah

        s = Surah.objects.filter(number=d.surah, source=d.quran_source).first() if d.quran_source_id else Surah.objects.filter(number=d.surah).first()
        name = s.name_ar.replace("سورة ", "") if s and s.name_ar else f"سورة {str(d.surah).translate(DIGITS)}"
        rng = str(d.ayah_from) if d.ayah_from == d.ayah_to else f"{d.ayah_from}–{d.ayah_to}"
        return f"{name}: {rng.translate(DIGITS)}"
    g = d.get_grading_display() + (f" ({d.graded_by})" if d.graded_by else "")
    return f"{d.hadith_collection} ({d.hadith_number.translate(DIGITS)}) · {g}"


def notice_text(d: Dhikr) -> tuple[str, str]:
    """Title and body of the phone notice: the verified text (shortened at a word for long ones) and its source."""
    t = " ".join(d.text.split())
    if len(t) > 220:
        t = t[:220].rsplit(" ", 1)[0] + " …"
    return TITLE.get(d.category, "الحلقة | ذكر الله"), f"{t}\n{source_label(d)}"


def eligible(user, categories: list[str] | None = None, times: list[str] | None = None):
    """Approved, enabled entries for these categories / times of day, least recently sent to this user first."""
    qs = Dhikr.objects.filter(status=Dhikr.Status.APPROVED, enabled=True)
    if categories is not None:
        qs = qs.filter(category__in=categories)
    if times is not None:
        qs = qs.filter(time_of_day__in=times)
    last = Delivery.objects.filter(user=user, dhikr=OuterRef("pk")).order_by().values("dhikr").annotate(m=Max("sent_at")).values("m")
    return qs.annotate(last_sent=Subquery(last)).order_by(F("last_sent").asc(nulls_first=True), "pk")


def local_now(user, now=None) -> datetime:
    return (now or timezone.now()).astimezone(zone(getattr(user, "timezone", None)))


def due_at(local: datetime, hour: int) -> datetime:
    wall = datetime.combine(local.date(), time(hour), tzinfo=local.tzinfo)
    return wall.astimezone(dt_timezone.utc).astimezone(local.tzinfo)  # a skipped wall time → the transition moment


def due(p: Preferences, local: datetime) -> list[tuple[str, str, list[str] | None, list[str] | None]]:
    """[(slot, kind, categories, times)] due now, most specific first. Empty in quiet hours."""
    if not p.enabled or p.in_quiet(local.hour):
        return []
    out = []
    day = local.date().isoformat()
    for kind, tod in TIMED.items():
        if getattr(p, f"{kind}_on"):
            at = due_at(local, getattr(p, f"{kind}_hour"))
            if at <= local < at + timedelta(hours=CATCH_UP):
                out.append((f"{kind}:{day}", kind, None, [tod]))  # entries of that time of day, any category
    n = p.interval_hours
    if n in (1, 2, 3, 4) and p.window_start <= local.hour < p.window_end and (local.hour - p.window_start) % n == 0:
        cats = GENERAL + (["quran_dua"] if p.quran_dua_on else []) + (["sunnah_dua"] if p.sunnah_dua_on else [])
        out.append((f"p:{day}:{local.hour:02d}", "periodic", cats, [Dhikr.Time.ANY]))
    return out


def send(user, d: Dhikr, slot: str):
    """Record the slot (unique) and create the notice; its push goes out after commit (notification outbox).
    Returns the Notification, or None when this slot was already used."""
    from apps.notifications.services import notify

    title, body = notice_text(d)
    try:
        with transaction.atomic():
            dl = Delivery.objects.create(user=user, dhikr=d, slot=slot)
            n = notify(user, f"adhkar_{d.category}", title, body, link=f"/adhkar/{d.pk}", dedupe=f"adhkar:{slot}",
                       data={"dhikr": d.pk})
            if n is None:
                raise IntegrityError("notice already exists")
            Delivery.objects.filter(pk=dl.pk).update(notification=n)
            return n
    except IntegrityError:
        return None


def run(now=None) -> dict:
    """The hourly job. Returns counts."""
    from apps.accounts.models import AccountStatus, User

    now = now or timezone.now()
    out = {"sent": 0, "skipped_empty": 0, "accounts": 0}
    users = (User.objects.filter(status=AccountStatus.ACTIVE, is_active=True, push_subscriptions__active=True)
             .distinct().select_related("adhkar_prefs"))
    for u in users:
        p = prefs_for(u)
        local = local_now(u, now)
        slots = due(p, local)
        if not slots:
            continue
        out["accounts"] += 1
        for slot, kind, cats, times in slots:
            if Delivery.objects.filter(user=u, slot=slot).exists():
                continue
            d = eligible(u, cats, times).first()
            if d is None:
                out["skipped_empty"] += 1
                continue
            if send(u, d, slot) is not None:
                out["sent"] += 1
                break  # at most one adhkar notice per account per run
    return out
