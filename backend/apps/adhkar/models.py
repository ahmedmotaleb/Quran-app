"""«الأذكار والأدعية» (owner request, 13 Nov 2026): a library of adhkar and duas from the Holy Quran and authentic
Sunnah only, and scheduled phone reminders from it.

Rules enforced here, not by convention:
- Quranic entries store a surah/ayah reference; their Arabic text is COPIED from the verified Quran text imported from
  Tanzil (apps.quran), never typed by a person or generated.
- Hadith entries need the collection, its reference number and a Sahih/Hasan grading (with who graded it); their text
  is entered by an administrator from that source.
- Every entry starts «بانتظار المراجعة» and only an administrator with `adhkar.approve` can approve it. Only approved
  AND enabled entries are shown in the app or sent. Changing the text or the source sends it back to review.
"""
from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.core.models import TimeStamped


class Dhikr(TimeStamped):
    class Category(models.TextChoices):
        MORNING = "morning", "أذكار الصباح"
        EVENING = "evening", "أذكار المساء"
        SLEEP = "sleep", "أذكار النوم"
        WAKING = "waking", "أذكار الاستيقاظ"
        ISTIGHFAR = "istighfar", "الاستغفار"
        TASBIH = "tasbih", "التسبيح"
        TAHMID = "tahmid", "التحميد"
        TAKBIR = "takbir", "التكبير"
        SALAWAT = "salawat", "الصلاة على النبي ﷺ"
        QURAN_DUA = "quran_dua", "أدعية من القرآن"
        SUNNAH_DUA = "sunnah_dua", "أدعية من السنة"
        DHIKR = "dhikr", "ذكر الله"
        QURAN_MOTIVATION = "quran_motivation", "فضل القرآن وحفظه"

    class Source(models.TextChoices):
        QURAN = "quran", "القرآن الكريم"
        HADITH = "hadith", "السنة النبوية"

    class Grading(models.TextChoices):
        SAHIH = "sahih", "صحيح"
        HASAN = "hasan", "حسن"

    class Time(models.TextChoices):
        ANY = "any", "في أي وقت"
        MORNING = "morning", "الصباح"
        EVENING = "evening", "المساء"
        SLEEP = "sleep", "عند النوم"
        WAKING = "waking", "عند الاستيقاظ"

    class Status(models.TextChoices):
        PENDING = "pending", "بانتظار المراجعة"
        APPROVED = "approved", "معتمد"
        REJECTED = "rejected", "مرفوض"

    category = models.CharField(max_length=20, choices=Category.choices)
    source_type = models.CharField(max_length=10, choices=Source.choices)
    text = models.TextField()  # Quran: copied verbatim from the verified text; Hadith: entered from the cited source
    # Quran
    surah = models.PositiveSmallIntegerField(null=True, blank=True)
    ayah_from = models.PositiveSmallIntegerField(null=True, blank=True)
    ayah_to = models.PositiveSmallIntegerField(null=True, blank=True)
    quran_source = models.ForeignKey("quran.QuranSource", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    # Hadith
    hadith_collection = models.CharField(max_length=120, blank=True)   # e.g. «صحيح البخاري»
    hadith_number = models.CharField(max_length=40, blank=True)        # the collection's reference number
    grading = models.CharField(max_length=8, choices=Grading.choices, blank=True)
    graded_by = models.CharField(max_length=120, blank=True)            # who graded it (for collections other than the two Sahihs)
    reference_url = models.URLField(max_length=500, blank=True)
    # Use
    repetition = models.PositiveSmallIntegerField(null=True, blank=True)  # only when the source establishes a number
    time_of_day = models.CharField(max_length=10, choices=Time.choices, default=Time.ANY)
    # Review
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    enabled = models.BooleanField(default=True)
    origin = models.CharField(max_length=20, default="admin")  # admin | quran_reference (proposed reference, see seed.py)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    reviewed_at = models.DateTimeField(null=True, blank=True)
    review_note = models.CharField(max_length=300, blank=True)

    class Meta:
        ordering = ["category", "id"]
        constraints = [
            models.CheckConstraint(name="dhikr_quran_reference", condition=~Q(source_type="quran") | Q(
                surah__gte=1, surah__lte=114, ayah_from__gte=1, ayah_to__gte=models.F("ayah_from"))),
            models.CheckConstraint(name="dhikr_hadith_reference", condition=~Q(source_type="hadith") | (
                ~Q(hadith_collection="") & ~Q(hadith_number="") & Q(grading__in=["sahih", "hasan"]))),
            models.UniqueConstraint(fields=["surah", "ayah_from", "ayah_to"], condition=Q(source_type="quran"), name="dhikr_quran_once"),
        ]
        indexes = [models.Index(fields=["status", "enabled", "category"])]

    @property
    def live(self) -> bool:
        return self.status == self.Status.APPROVED and self.enabled


class Preferences(models.Model):
    """«إعدادات الأذكار والتنبيهات», per user (kept across sign-out, restarts and devices). Hours are local hours in
    the user's time zone (User.timezone, which follows the device)."""

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="adhkar_prefs")
    enabled = models.BooleanField(default=True)                  # «تفعيل الأذكار»
    interval_hours = models.PositiveSmallIntegerField(default=2)  # 0 = off; 1, 2, 3 or 4
    window_start = models.PositiveSmallIntegerField(default=8)   # periodic reminders from 08:00 …
    window_end = models.PositiveSmallIntegerField(default=22)    # … until 22:00
    morning_on = models.BooleanField(default=True)
    morning_hour = models.PositiveSmallIntegerField(default=7)
    evening_on = models.BooleanField(default=True)
    evening_hour = models.PositiveSmallIntegerField(default=17)
    sleep_on = models.BooleanField(default=True)
    sleep_hour = models.PositiveSmallIntegerField(default=22)
    quran_dua_on = models.BooleanField(default=True)
    sunnah_dua_on = models.BooleanField(default=True)
    quiet_start = models.PositiveSmallIntegerField(default=23)   # nothing from quiet_start …
    quiet_end = models.PositiveSmallIntegerField(default=6)      # … until quiet_end
    updated_at = models.DateTimeField(auto_now=True)

    def in_quiet(self, hour: int) -> bool:
        s, e = self.quiet_start, self.quiet_end
        return s != e and ((s <= hour < e) if s < e else (hour >= s or hour < e))


class Favorite(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="adhkar_favorites")
    dhikr = models.ForeignKey(Dhikr, on_delete=models.CASCADE, related_name="favorites")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["user", "dhikr"], name="adhkar_favorite_once")]


class Delivery(models.Model):
    """One scheduled reminder slot for one user (the idempotency key) and which entry it carried — used to rotate
    through the library before repeating, and for statistics. The phone delivery itself is the Notification's outbox."""

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="adhkar_deliveries")
    dhikr = models.ForeignKey(Dhikr, on_delete=models.CASCADE, related_name="deliveries")
    slot = models.CharField(max_length=40)  # p:2026-11-13:10 · morning:2026-11-13 · test:<ts>
    notification = models.ForeignKey("notifications.Notification", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    sent_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["user", "slot"], name="adhkar_one_per_slot")]
        indexes = [models.Index(fields=["user", "dhikr", "sent_at"])]
