from __future__ import annotations

from rest_framework import serializers

from .models import Booking, BookingExcuse, SessionOccurrence


def booking_excuse(b) -> BookingExcuse | None:
    try:
        return b.excuse
    except BookingExcuse.DoesNotExist:
        return None


class SlotSerializer(serializers.ModelSerializer):
    teacher_name = serializers.CharField(source="teacher.full_name")
    seats_left = serializers.SerializerMethodField()
    circle_name = serializers.CharField(source="circle.name", default=None)

    class Meta:
        model = SessionOccurrence
        fields = ["id", "teacher", "teacher_name", "kind", "starts_at", "ends_at", "capacity", "seats_left", "circle_name",
                  "topic", "title", "prep_note"]

    def get_seats_left(self, o):
        return max(0, o.capacity - getattr(o, "confirmed_count", 0) - getattr(o, "held_count", 0))


class BookingSerializer(serializers.ModelSerializer):
    occurrence = SlotSerializer(read_only=True)
    student_name = serializers.CharField(source="student.full_name", read_only=True)
    can_join = serializers.SerializerMethodField()
    has_meeting_link = serializers.SerializerMethodField()
    excuse = serializers.SerializerMethodField()
    excuse_deadline = serializers.SerializerMethodField()
    can_excuse = serializers.SerializerMethodField()

    class Meta:
        model = Booking
        fields = ["id", "occurrence", "student", "student_name", "status", "assignment", "note", "attendance", "cancelled_at", "cancel_reason",
                  "rescheduled_from", "created_at", "can_join", "has_meeting_link", "excuse", "excuse_deadline", "can_excuse"]

    def _user(self):
        return self.context["request"].user if "request" in self.context else None

    def get_excuse(self, b):
        """Reason and teacher response for the student, the teacher and admins; parents see the status only."""
        from .views import excuse_out

        ex = booking_excuse(b)
        if ex is None:
            return None
        u = self._user()
        return excuse_out(ex, private=u is None or u.role != "parent")

    def get_excuse_deadline(self, b):
        from .excuses import deadline

        return deadline(b).isoformat()

    def get_can_excuse(self, b):
        from django.utils import timezone

        from .excuses import deadline

        u = self._user()
        return bool(u is not None and b.student_id == u.pk and b.status == Booking.Status.CONFIRMED and booking_excuse(b) is None
                    and b.occurrence.status != "cancelled" and timezone.now() <= deadline(b))

    def get_can_join(self, b):
        """Only the booked student joins (parents never: product policy). The link itself comes from bookings/<id>/join."""
        user = self.context["request"].user if "request" in self.context else None
        return bool(user is not None and b.student_id == user.pk and b.pk in self.context.get("joinable", set()))

    def get_has_meeting_link(self, b):
        return bool(b.occurrence.meeting_url)


class BookingCreateSerializer(serializers.Serializer):
    occurrence = serializers.IntegerField()
    assignment = serializers.IntegerField(required=False, allow_null=True)
    note = serializers.CharField(required=False, allow_blank=True, max_length=500, default="")
    makeup_credit = serializers.IntegerField(required=False, allow_null=True)  # «جلسة تعويضية» (makeup.py)


class AttendanceSerializer(serializers.Serializer):
    attendance = serializers.ChoiceField(choices=[c for c in Booking.Attendance.values if c])


class TeacherOccurrenceSerializer(serializers.ModelSerializer):
    """The teacher's own session with who booked it (names and attendance only)."""

    bookings = serializers.SerializerMethodField()

    class Meta:
        model = SessionOccurrence
        fields = ["id", "kind", "starts_at", "ends_at", "capacity", "status", "bookings", "meeting_provider", "meeting_url",
                  "topic", "title", "prep_note", "circle_name", "google"]

    circle_name = serializers.CharField(source="circle.name", default=None)
    google = serializers.SerializerMethodField()

    def get_google(self, o):
        """Google Calendar state of a teacher-created session (null for other sessions). No tokens, ever."""
        ev = getattr(o, "google_event", None) if hasattr(o, "google_event") else None
        if ev is None:
            return None
        from apps.integrations.views import google_out

        return {**google_out(ev, teacher_view=True), "student": ev.student_id, "student_name": ev.student.full_name if ev.student else ""}

    def get_bookings(self, o):
        from .views import excuse_out

        return [{"id": b.id, "student": b.student_id, "student_name": b.student.full_name, "attendance": b.attendance,
                 "assignment_title": b.assignment.title if b.assignment else "", "note": b.note,
                 "excuse": excuse_out(ex) if (ex := booking_excuse(b)) else None,
                 # «جلسة تعويضية» granted for this absence (status), or null
                 "makeup": getattr(getattr(b, "makeup_credit", None), "status", None) if hasattr(b, "makeup_credit") else None}
                for b in o.bookings.all() if b.status == Booking.Status.CONFIRMED]


class OpenSlotSerializer(serializers.Serializer):
    starts_at = serializers.DateTimeField()
    minutes = serializers.IntegerField(min_value=15, max_value=120, default=45)
