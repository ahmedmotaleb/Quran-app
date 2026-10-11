from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.exceptions import ApiError

from .models import Ayah, QuranSource, Surah

UNAVAILABLE = ApiError("quran_unavailable", "النص القرآني غير متاح حاليًا من المصدر المعتمد.", 503)


def active_source() -> QuranSource:
    src = QuranSource.objects.filter(is_active=True).first()
    if src is None:
        raise UNAVAILABLE
    return src


class SurahSerializer(serializers.ModelSerializer):
    class Meta:
        model = Surah
        fields = ["number", "name_ar", "name_en", "ayah_count", "revelation"]


class SourceView(APIView):
    def get(self, request):
        s = active_source()
        return Response({"slug": s.slug, "name": s.name, "edition": s.edition, "narration": s.narration, "version": s.version,
                         "license": s.license_name, "attribution": s.attribution, "url": s.source_url})


class SurahList(APIView):
    def get(self, request):
        src = active_source()
        return Response(SurahSerializer(Surah.objects.filter(source=src), many=True).data)


class SurahText(APIView):
    """Verbatim ayahs for a surah, optionally a range (?from=&to=)."""

    def get(self, request, number: int):
        src = active_source()
        surah = Surah.objects.filter(source=src, number=number).first()
        if surah is None:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        a = int(request.query_params.get("from", 1) or 1)
        b = int(request.query_params.get("to", surah.ayah_count) or surah.ayah_count)
        ayahs = Ayah.objects.filter(surah=surah, number__gte=max(1, a), number__lte=min(b, surah.ayah_count)).values("number", "text", "juz", "page")
        return Response({"source": src.slug, "surah": SurahSerializer(surah).data, "ayahs": list(ayahs)})
