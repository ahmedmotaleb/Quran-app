"""
Quran reference data. Text is imported verbatim from a verified source (e.g. Tanzil) with its
version and checksum, and is never edited through the application.
"""
from django.db import models

# Ayah counts per surah in the Hafs ʿan ʿĀṣim numbering used by Tanzil (114 surahs, 6236 ayahs).
HAFS_AYAH_COUNTS = (
    7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128, 111, 110, 98, 135,
    112, 78, 118, 64, 77, 227, 93, 88, 69, 60, 34, 30, 73, 54, 45, 83, 182, 88, 75, 85,
    54, 53, 89, 59, 37, 35, 38, 29, 18, 45, 60, 49, 62, 55, 78, 96, 29, 22, 24, 13,
    14, 11, 11, 18, 12, 12, 30, 52, 52, 44, 28, 28, 20, 56, 40, 31, 50, 40, 46, 42,
    29, 19, 36, 25, 22, 17, 19, 26, 30, 20, 15, 21, 11, 8, 8, 19, 5, 8, 8, 11,
    11, 8, 3, 9, 5, 4, 7, 3, 6, 3, 5, 4, 5, 6,
)
assert len(HAFS_AYAH_COUNTS) == 114 and sum(HAFS_AYAH_COUNTS) == 6236


class QuranSource(models.Model):
    slug = models.SlugField(unique=True)  # e.g. tanzil-uthmani
    name = models.CharField(max_length=120)
    edition = models.CharField(max_length=120)  # e.g. "Uthmani (Tanzil)"
    narration = models.CharField(max_length=60, default="حفص عن عاصم")
    version = models.CharField(max_length=40)
    source_url = models.URLField(blank=True)
    license_name = models.CharField(max_length=120)
    attribution = models.TextField(help_text="Notice that must be shown in the app.")
    sha256 = models.CharField(max_length=64)
    is_active = models.BooleanField(default=False)
    imported_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["is_active"], condition=models.Q(is_active=True), name="one_active_quran_source")]

    def __str__(self):
        return f"{self.name} {self.version}"


class Surah(models.Model):
    source = models.ForeignKey(QuranSource, on_delete=models.PROTECT, related_name="surahs")
    number = models.PositiveSmallIntegerField()
    name_ar = models.CharField(max_length=60)
    name_en = models.CharField(max_length=80, blank=True)
    ayah_count = models.PositiveSmallIntegerField()
    revelation = models.CharField(max_length=10, blank=True)  # Meccan / Medinan

    class Meta:
        ordering = ["number"]
        constraints = [
            models.UniqueConstraint(fields=["source", "number"], name="surah_unique_per_source"),
            models.CheckConstraint(condition=models.Q(number__gte=1, number__lte=114), name="surah_number_range"),
        ]


class Ayah(models.Model):
    source = models.ForeignKey(QuranSource, on_delete=models.PROTECT, related_name="ayahs")
    surah = models.ForeignKey(Surah, on_delete=models.PROTECT, related_name="ayahs")
    number = models.PositiveSmallIntegerField()  # number within the surah
    text = models.TextField()  # verbatim; never normalised
    search_text = models.TextField(blank=True)  # diacritics stripped, search only — never displayed
    juz = models.PositiveSmallIntegerField(null=True, blank=True)
    page = models.PositiveSmallIntegerField(null=True, blank=True)

    class Meta:
        ordering = ["surah__number", "number"]
        constraints = [models.UniqueConstraint(fields=["surah", "number"], name="ayah_unique_per_surah")]
        indexes = [models.Index(fields=["source", "surah", "number"])]
