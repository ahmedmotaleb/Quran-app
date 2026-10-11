from rest_framework import serializers

from .models import Booking, SessionOccurrence


class SlotSerializer(serializers.ModelSerializer):
    teacher_name = serializers.CharField(source="teacher.full_name")
    seats_left = serializers.SerializerMethodField()

    class Meta:
        model = SessionOccurrence
        fields = ["id", "teacher", "teacher_name", "kind", "starts_at", "ends_at", "capacity", "seats_left"]

    def get_seats_left(self, o):
        return max(0, o.capacity - getattr(o, "confirmed_count", 0))


class BookingSerializer(serializers.ModelSerializer):
    occurrence = SlotSerializer(read_only=True)
    student_name = serializers.CharField(source="student.full_name", read_only=True)
    can_join = serializers.SerializerMethodField()

    class Meta:
        model = Booking
        fields = ["id", "occurrence", "student", "student_name", "status", "assignment", "note", "attendance", "cancelled_at", "cancel_reason",
                  "rescheduled_from", "created_at", "can_join"]

    def get_can_join(self, b):
        return bool(self.context.get("joinable", set()) and b.pk in self.context["joinable"])


class BookingCreateSerializer(serializers.Serializer):
    occurrence = serializers.IntegerField()
    assignment = serializers.IntegerField(required=False, allow_null=True)
    note = serializers.CharField(required=False, allow_blank=True, max_length=500, default="")


class AttendanceSerializer(serializers.Serializer):
    attendance = serializers.ChoiceField(choices=[c for c in Booking.Attendance.values if c])
