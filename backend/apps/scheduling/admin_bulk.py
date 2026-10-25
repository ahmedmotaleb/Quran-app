"""Admin circles, sessions and bookings: validated filters, sort and bulk actions.

Nothing with attendance or booking history is deleted: bookings and sessions are cancelled (students notified,
records kept). Only a draft circle that never had a session can be deleted.
"""
from __future__ import annotations

from django.db.models import Exists, OuterRef
from django.utils import timezone

from apps.core.bulk import Action, FilterSpec, Refuse, Resource, Skip, date_range, p_bool, p_choice, p_date, p_int, p_text, register, search_q
from apps.core.exceptions import ApiError

from . import services
from .models import Booking, Circle, SessionOccurrence


# ---- Circles ---------------------------------------------------------------------------
def _circles_apply(qs, f):
    if "state" in f:
        qs = qs.filter(state=f["state"])
    if "teacher" in f:
        qs = qs.filter(teacher_id=f["teacher"])
    if f.get("q"):
        qs = qs.filter(search_q(f["q"], ["name", "teacher__full_name"]))
    if f.get("level"):
        qs = qs.filter(level__iexact=f["level"])
    if "has_upcoming" in f:
        e = Exists(SessionOccurrence.objects.filter(circle=OuterRef("pk"), status=SessionOccurrence.Status.SCHEDULED, starts_at__gt=timezone.now()))
        qs = qs.filter(e if f["has_upcoming"] else ~e)
    return date_range(qs, f, "created_at", "created_from", "created_to")


CIRCLE_FILTERS = FilterSpec(
    parsers={"state": p_choice(*Circle.State.values), "teacher": p_int, "q": p_text, "level": p_text, "has_upcoming": p_bool,
             "created_from": p_date, "created_to": p_date},
    apply=_circles_apply,
    sorts={"name": ("name",), "updated": ("updated_at",), "created": ("created_at",), "capacity": ("capacity",), "state": ("state",)},
    default_sort="-updated",
)


def _circle_state(new: str):
    def run(c: Circle, actor, reason: str):
        if c.state == new:
            raise Skip("unchanged", "في هذه الحالة بالفعل.")
        if new == Circle.State.PUBLISHED:
            prof = getattr(c.teacher, "teacher_profile", None)
            if not prof or not prof.approved_at or c.teacher.status != "active":
                raise Refuse("teacher_not_approved", "معلم الحلقة غير معتمد.")
        c.state = new
        c.save(update_fields=["state", "updated_at"])
    return run


def _circle_delete(c: Circle, actor, reason: str):
    if c.state != Circle.State.DRAFT:
        raise Refuse("not_draft", "تُحذف المسودات فقط؛ أوقف الحلقة بدلًا من ذلك.")
    if c.occurrences.exists():
        raise Refuse("has_history", "للحلقة جلسات محفوظة؛ لا يمكن حذفها.")
    c.delete()


register(Resource(
    name="circles", label="scheduling.circle", base=lambda: Circle.objects.select_related("teacher__teacher_profile"),
    filters=CIRCLE_FILTERS, describe=lambda c: c.name,
    actions={
        "publish": Action(_circle_state(Circle.State.PUBLISHED)),
        "disable": Action(_circle_state(Circle.State.OFF), reason_required=True),
        "draft": Action(_circle_state(Circle.State.DRAFT)),
        "delete": Action(_circle_delete, destructive=True),
    },
    export=[("الرقم", lambda c: c.pk), ("الحلقة", lambda c: c.name), ("المعلم", lambda c: c.teacher.display_name), ("المستوى", lambda c: c.level),
            ("السعة", lambda c: c.capacity), ("المواعيد", lambda c: c.schedule_note), ("الحالة", lambda c: Circle.State(c.state).label)],
))


# ---- Bookings --------------------------------------------------------------------------
ATTENDANCE = ("present", "late", "absent", "excused", "unmarked")


def _bookings_apply(qs, f):
    now = timezone.now()
    when = f.get("when", "upcoming")
    if when == "upcoming":
        qs = qs.filter(occurrence__starts_at__gte=now)
    elif when == "past":
        qs = qs.filter(occurrence__starts_at__lt=now)
    if "status" in f:
        qs = qs.filter(status=f["status"])
    if "attendance" in f:
        qs = qs.filter(attendance="" if f["attendance"] == "unmarked" else f["attendance"])
    if "teacher" in f:
        qs = qs.filter(occurrence__teacher_id=f["teacher"])
    if "student" in f:
        qs = qs.filter(student_id=f["student"])
    if "circle" in f:
        qs = qs.filter(occurrence__circle_id=f["circle"])
    if "kind" in f:
        qs = qs.filter(occurrence__kind=f["kind"])
    if f.get("q"):
        qs = qs.filter(search_q(f["q"], ["student__full_name", "occurrence__teacher__full_name", "occurrence__circle__name"]))
    return date_range(qs, f, "occurrence__starts_at", "from", "to")


BOOKING_FILTERS = FilterSpec(
    parsers={"when": p_choice("upcoming", "past", "all"), "status": p_choice(*Booking.Status.values), "attendance": p_choice(*ATTENDANCE),
             "teacher": p_int, "student": p_int, "circle": p_int, "kind": p_choice(*SessionOccurrence.Kind.values), "q": p_text,
             "from": p_date, "to": p_date},
    apply=_bookings_apply,
    sorts={"starts": ("occurrence__starts_at",), "student": ("student__full_name",), "teacher": ("occurrence__teacher__full_name",),
           "status": ("status",), "created": ("created_at",)},
    default_sort="starts",
)


def _booking_cancel(b: Booking, actor, reason: str):
    if b.status != Booking.Status.CONFIRMED:
        raise Skip("unchanged", "ملغى بالفعل.")
    if b.occurrence.starts_at <= timezone.now():
        raise Refuse("already_started", "بدأت الجلسة أو انتهت؛ السجل يبقى كما هو.")
    services.cancel(booking_id=b.pk, by=actor, reason=reason)  # same locks and student notice as a single cancel


register(Resource(
    name="bookings", label="scheduling.booking",
    base=lambda: Booking.objects.select_related("occurrence", "student"), lock=False,  # services.cancel locks the row itself
    filters=BOOKING_FILTERS, describe=lambda b: f"{b.student.full_name} · {timezone.localtime(b.occurrence.starts_at):%Y-%m-%d %H:%M}",
    actions={"cancel": Action(_booking_cancel, reason_required=True)},
    # The student's free-text note is not exported.
    export=[("الرقم", lambda b: b.pk), ("الطالب", lambda b: b.student.full_name), ("المعلم", lambda b: b.occurrence.teacher.display_name),
            ("الموعد", lambda b: b.occurrence.starts_at), ("النوع", lambda b: SessionOccurrence.Kind(b.occurrence.kind).label),
            ("الحالة", lambda b: Booking.Status(b.status).label),
            ("الحضور", lambda b: Booking.Attendance(b.attendance).label if b.attendance else ""), ("أُلغي في", lambda b: b.cancelled_at),
            ("تاريخ الحجز", lambda b: b.created_at)],
))


# ---- Sessions (inside a circle) ----------------------------------------------------------
def _session_cancel(o: SessionOccurrence, actor, reason: str):
    if o.status == SessionOccurrence.Status.CANCELLED:
        raise Skip("unchanged", "ملغاة بالفعل.")
    if o.starts_at <= timezone.now():
        raise Refuse("already_started", "بدأت الجلسة أو انتهت؛ السجل يبقى كما هو.")
    try:
        services.cancel_occurrence(occurrence_id=o.pk, by=actor, reason=reason)
    except ApiError as e:
        raise Refuse(e.code, str(e.detail)) from None


SESSION_FILTERS = FilterSpec(
    parsers={"circle": p_int, "teacher": p_int, "status": p_choice(*SessionOccurrence.Status.values), "from": p_date, "to": p_date},
    apply=lambda qs, f: date_range(qs.filter(**{k: f[k] for k in ("status",) if k in f})
                                   .filter(**({"circle_id": f["circle"]} if "circle" in f else {}))
                                   .filter(**({"teacher_id": f["teacher"]} if "teacher" in f else {})), f, "starts_at", "from", "to"),
    sorts={"starts": ("starts_at",)}, default_sort="starts",
)

register(Resource(
    name="sessions", label="scheduling.sessionoccurrence", base=lambda: SessionOccurrence.objects.all(), lock=False,
    filters=SESSION_FILTERS, describe=lambda o: f"{timezone.localtime(o.starts_at):%Y-%m-%d %H:%M}",
    actions={"cancel": Action(_session_cancel, reason_required=True)},
    export=[("الرقم", lambda o: o.pk), ("المعلم", lambda o: o.teacher.display_name), ("البداية", lambda o: o.starts_at), ("النهاية", lambda o: o.ends_at),
            ("النوع", lambda o: SessionOccurrence.Kind(o.kind).label), ("السعة", lambda o: o.capacity),
            ("المحجوز", lambda o: o.bookings.filter(status=Booking.Status.CONFIRMED).count()),
            ("الحالة", lambda o: SessionOccurrence.Status(o.status).label)],
))
