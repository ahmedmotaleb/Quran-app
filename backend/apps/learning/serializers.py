from rest_framework import serializers

from apps.quran.models import HAFS_AYAH_COUNTS

from .models import Assignment


class AssignmentSerializer(serializers.ModelSerializer):
    teacher_name = serializers.CharField(source="teacher.full_name", read_only=True)
    student_name = serializers.CharField(source="student.full_name", read_only=True)

    class Meta:
        model = Assignment
        fields = ["id", "student", "student_name", "teacher", "teacher_name", "kind", "title", "surah", "ayah_from", "ayah_to",
                  "instructions", "due_at", "requires_recording", "status", "next_review_on", "created_at"]
        read_only_fields = ["id", "teacher", "status", "next_review_on", "created_at"]

    def validate(self, attrs):
        surah = attrs.get("surah", getattr(self.instance, "surah", None))
        a = attrs.get("ayah_from", getattr(self.instance, "ayah_from", None))
        b = attrs.get("ayah_to", getattr(self.instance, "ayah_to", None))
        errors = {}
        if surah is None or not 1 <= surah <= 114:
            errors["surah"] = ["اختر سورة صحيحة."]
        else:
            n = HAFS_AYAH_COUNTS[surah - 1]
            if a is None or a < 1:
                errors["ayah_from"] = ["أدخل رقم آية البداية."]
            elif a > n:
                errors["ayah_from"] = [f"السورة تحتوي {n} آية فقط."]
            if b is None or b < 1:
                errors["ayah_to"] = ["أدخل رقم آية النهاية."]
            elif b > n:
                errors["ayah_to"] = [f"السورة تحتوي {n} آية فقط."]
            elif a and b < a:
                errors["ayah_to"] = ["يجب أن تكون النهاية بعد البداية."]
        if errors:
            raise serializers.ValidationError(errors)
        return attrs


class FeedbackNoteSerializer(serializers.Serializer):
    at_seconds = serializers.FloatField(min_value=0)
    text = serializers.CharField(max_length=500)
    category = serializers.CharField(max_length=32, required=False, allow_blank=True, default="")


class FeedbackInSerializer(serializers.Serializer):
    score_hifz = serializers.IntegerField(min_value=1, max_value=5)
    score_tajweed = serializers.IntegerField(min_value=1, max_value=5)
    score_fluency = serializers.IntegerField(min_value=1, max_value=5)
    decision = serializers.ChoiceField(choices=["accept", "repeat"])
    general = serializers.CharField(required=False, allow_blank=True, max_length=2000, default="")
    needs_review = serializers.CharField(required=False, allow_blank=True, max_length=200, default="")
    next_step = serializers.CharField(required=False, allow_blank=True, max_length=200, default="")
    notes = FeedbackNoteSerializer(many=True, required=False, default=list)
    voice = serializers.UUIDField(required=False, allow_null=True, default=None)

    def validate(self, attrs):
        if attrs["decision"] == "repeat" and not attrs["needs_review"].strip():
            raise serializers.ValidationError({"needs_review": ["حدّد ما يحتاج الطالب إلى إعادته."]})
        if len(attrs["notes"]) > 50:
            raise serializers.ValidationError({"notes": ["50 ملاحظة كحد أقصى."]})
        return attrs
