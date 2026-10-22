"""Weekly in-app summary for each parent (setting «تقرير أولياء الأمور», on by default).

Runs from the hourly job; it only sends on Friday from 18:00 Cairo time, once per parent per ISO week (dedupe key),
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
SEND_WEEKDAY, SEND_HOUR = 4, 18  # Friday 18:00 (Python: Monday = 0)


def due(now: datetime) -> bool:
    local = now.astimezone(CAIRO)
    return local.weekday() == SEND_WEEKDAY and local.hour >= SEND_HOUR


def child_line(c: dict) -> str:
    parts = [f"{c['submissions']} تسجيل"]
    if c["sessions"]:
        rate = c["attendance_rate"]
        parts.append(f"حضور {round(rate * 100)}٪ من {c['sessions']} جلسة" if rate is not None else f"{c['sessions']} جلسة")
    late = c["assignments_overdue"] + c["reviews_overdue"]
    parts.append(f"{late} مهمة متأخرة" if late else "لا مهام متأخرة")
    return f"{c['child']['name']}: " + " · ".join(parts)


def send_all(now: datetime) -> int:
    year, week, _ = now.astimezone(CAIRO).isocalendar()
    parents = User.objects.filter(role=Role.PARENT, status=AccountStatus.ACTIVE, is_active=True,
                                  pk__in=GuardianLink.objects.filter(status=LinkStatus.ACTIVE).values("guardian_id"))
    sent = 0
    for p in parents.iterator():
        s = weekly_summary(p)
        if not s["children"]:
            continue
        body = "\n".join(child_line(c) for c in s["children"])
        sent += bool(notify(p, "weekly_report", "ملخص الأسبوع لأبنائك", body, link="/", dedupe=f"weekly_report:{year}-W{week:02d}",
                            data={"from": s["week"]["from"], "to": s["week"]["to"]}))
    return sent


class Command(BaseCommand):
    help = "Send the weekly parent summary (Friday evening, Cairo time; once per week)."

    def add_arguments(self, parser):
        parser.add_argument("--force", action="store_true", help="send now, whatever the day (still once per week)")

    def handle(self, *args, force=False, **_):
        if not AppSettings.load().parent_weekly_report:
            self.stdout.write("parent weekly reports: off in settings")
            return
        now = timezone.now()
        if not (force or due(now)):
            self.stdout.write("parent weekly reports: not due")
            return
        self.stdout.write(f"parent weekly reports sent: {send_all(now)}")
