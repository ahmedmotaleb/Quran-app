"""Weekly in-app summary for each parent (setting «تقرير أولياء الأمور», on by default).

Runs from the hourly job; it sends on the configured weekday from the configured hour (AppSettings
parent_report_weekday / parent_report_hour, local time in default_timezone; Friday 18:00 Cairo by default), once per
parent per ISO week (dedupe key), and also by email when parent_report_email is on (counts only, no teacher comments),
so an hourly run or a retry never sends twice. Only parents with active linked children get one. The in-app text has
short counts per child; a phone push shows only the generic lock-screen text (see push.GENERIC), never child data.
`--force` sends now regardless of the day (owner/ops testing).
"""
from datetime import datetime
from zoneinfo import ZoneInfo

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.accounts.models import AccountStatus, GuardianLink, LinkStatus, Role, User
from apps.core.models import AppSettings
from apps.learning.progress import weekly_summary
from apps.notifications.services import notify

CAIRO = ZoneInfo("Africa/Cairo")


def _zone(cfg) -> ZoneInfo:
    try:
        return ZoneInfo(cfg.default_timezone or "Africa/Cairo")
    except Exception:  # noqa: BLE001
        return CAIRO


def due(now: datetime, cfg=None) -> bool:
    cfg = cfg or AppSettings.load()
    local = now.astimezone(_zone(cfg))
    return local.weekday() == cfg.parent_report_weekday and local.hour >= cfg.parent_report_hour


def child_line(c: dict) -> str:
    parts = [f"{c['submissions']} تسجيل"]
    if c["sessions"]:
        rate = c["attendance_rate"]
        parts.append(f"حضور {round(rate * 100)}٪ من {c['sessions']} جلسة" if rate is not None else f"{c['sessions']} جلسة")
    late = c["assignments_overdue"] + c["reviews_overdue"]
    parts.append(f"{late} مهمة متأخرة" if late else "لا مهام متأخرة")
    if c.get("accepted_ayahs_total"):
        parts.append(f"{c['accepted_ayahs_total']} آية حفظ مقبولة")
    if c.get("reviews_completed"):
        parts.append(f"{c['reviews_completed']} مراجعة مكتملة")
    ab = c.get("absences") or {}
    if ab.get("unexcused"):
        parts.append(f"{ab['unexcused']} غياب بدون عذر")
    if ab.get("excused_approved"):
        parts.append(f"{ab['excused_approved']} غياب بعذر")
    if c.get("upcoming_sessions"):
        parts.append(f"{len(c['upcoming_sessions'])} جلسة قادمة")
    return f"{c['child']['name']}: " + " · ".join(parts)


def _email(parent, body: str, week: dict) -> None:
    from django.conf import settings

    from apps.accounts.emails import send_link_email

    send_link_email(parent.email, subject="ملخص الأسبوع لأبنائك — حَلْقة",
                    intro=f"ملخص الفترة {week['from']} إلى {week['to']}:\n" + body, cta="افتح التقرير في التطبيق",
                    link=f"{settings.FRONTEND_URL}/#/parent", expires_at=None, one_time=False)


def send_all(now: datetime, email: bool = False) -> int:
    year, week, _ = now.astimezone(CAIRO).isocalendar()
    parents = User.objects.filter(role=Role.PARENT, status=AccountStatus.ACTIVE, is_active=True,
                                  pk__in=GuardianLink.objects.filter(status=LinkStatus.ACTIVE).values("guardian_id"))
    sent = 0
    for p in parents.iterator():
        s = weekly_summary(p)
        if not s["children"]:
            continue
        body = "\n".join(child_line(c) for c in s["children"])
        n = notify(p, "weekly_report", "ملخص الأسبوع لأبنائك", body, link="/", dedupe=f"weekly_report:{year}-W{week:02d}",
                   data={"from": s["week"]["from"], "to": s["week"]["to"]})
        sent += bool(n)
        if n and email:  # once per week too: only when the in-app report was just created
            _email(p, body, s["week"])
    return sent


class Command(BaseCommand):
    help = "Send the weekly parent summary (Friday evening, Cairo time; once per week)."

    def add_arguments(self, parser):
        parser.add_argument("--force", action="store_true", help="send now, whatever the day (still once per week)")

    def handle(self, *args, force=False, **_):
        cfg = AppSettings.load()
        if not cfg.parent_weekly_report:
            self.stdout.write("parent weekly reports: off in settings")
            return
        now = timezone.now()
        if not (force or due(now, cfg)):
            self.stdout.write("parent weekly reports: not due")
            return
        self.stdout.write(f"parent weekly reports sent: {send_all(now, email=cfg.parent_report_email)}")
