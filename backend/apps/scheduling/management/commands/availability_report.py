"""Read-only: how ready each teacher's availability is after the switch from fixed times to ranges (25 Oct 2026).

For every active teacher (ids only, no names or emails): approved or not, weekly ranges and the weekdays they cover,
weekly hours, date-only changes ahead, sessions opened by hand still offered, upcoming booked sessions, whether Google
Calendar is connected, the bookable start times computed for the next 7 days, and when the availability was last
changed. One JSON log line per teacher plus a summary (Ops task availability-report). It changes nothing.

  python manage.py availability_report
"""
import json
import logging
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.db.models import Count, Max, Q
from django.utils import timezone

from apps.accounts.models import AccountStatus, Role, User
from apps.core.models import AuditEvent
from apps.scheduling import availability as av
from apps.scheduling.models import AvailabilityException, AvailabilityRule, Booking, SessionOccurrence

log = logging.getLogger("halqa.ops")


class Command(BaseCommand):
    help = "Report each teacher's availability ranges and bookable times (read-only, ids only)."

    def handle(self, **_):
        now = timezone.now()
        rows = []
        teachers = User.objects.filter(role=Role.TEACHER, status=AccountStatus.ACTIVE).select_related("teacher_profile").order_by("pk")
        changed = dict(AuditEvent.objects.filter(action__in=["teacher.availability_changed", "teacher.availability_admin_changed"])
                       .values_list("target_id").annotate(last=Max("created_at")).values_list("target_id", "last"))
        for t in teachers:
            rules = list(AvailabilityRule.objects.filter(teacher=t, active=True))
            upcoming = (SessionOccurrence.objects.filter(teacher=t, starts_at__gte=now).exclude(status="cancelled")
                        .annotate(n=Count("bookings", filter=Q(bookings__status=Booking.Status.CONFIRMED))))
            opened = [o for o in upcoming.select_related("google_event") if o.n == 0 and o.kind == "individual" and o.circle_id is None
                      and not av.is_placeholder(o)]
            try:
                starts = len(av.compute(t, now, now + timedelta(days=7), now=now))
            except Exception as e:  # noqa: BLE001 — a report must not stop on one teacher
                starts = f"error:{type(e).__name__}"
            last = changed.get(str(t.pk))
            prof = getattr(t, "teacher_profile", None)
            row = {"teacher": t.pk, "approved": bool(prof and prof.approved_at), "ranges": len(rules),
                   "weekdays": sorted({r.weekday for r in rules}),
                   "weekly_hours": round(sum(av.length(r.start_time, r.end_time) for r in rules) / 60, 1),
                   "overrides_ahead": AvailabilityException.objects.filter(teacher=t, date__gte=timezone.localdate()).count(),
                   "opened_by_hand": len(opened), "booked_upcoming": upcoming.filter(n__gt=0).count(),
                   "google": hasattr(t, "google_calendar") and t.google_calendar.status == "active",
                   "bookable_starts_7d": starts, "last_changed": last.isoformat() if last else None}
            rows.append(row)
            log.warning("availability_report_teacher", extra=row)
        approved = [r for r in rows if r["approved"]]
        summary = {"teachers": len(rows), "approved": len(approved),
                   "approved_with_ranges": sum(1 for r in approved if r["ranges"]),
                   "approved_without_ranges": sum(1 for r in approved if not r["ranges"]),
                   "without_ranges_but_opened_by_hand": sum(1 for r in approved if not r["ranges"] and r["opened_by_hand"]),
                   "changed_since_switch": sum(1 for r in rows if r["last_changed"])}
        log.warning("availability_report_summary", extra=summary)
        self.stdout.write(json.dumps({"summary": summary, "teachers": rows}, ensure_ascii=False))
