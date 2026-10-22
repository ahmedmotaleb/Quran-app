from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.exceptions import ApiError

from .models import HAFS_AYAH_COUNTS, Ayah, Bookmark, QuranSource, ReadingPosition, Surah

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
        try:
            a = int(request.query_params.get("from", 1) or 1)
            b = int(request.query_params.get("to", surah.ayah_count) or surah.ayah_count)
        except ValueError:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"from": ["أرقام آيات غير صحيحة."]}) from None
        ayahs = Ayah.objects.filter(surah=surah, number__gte=max(1, a), number__lte=min(b, surah.ayah_count)).values("number", "text", "juz", "page")
        return Response({"source": src.slug, "surah": SurahSerializer(surah).data, "ayahs": list(ayahs)})


# ---- Reading position and bookmarks (pack prompt 20) -------------------------------------
def _ref(data) -> tuple[int, int]:
    """A surah/ayah reference that exists in the Hafs numbering (the verified source uses the same counts)."""
    try:
        s, a = int(data.get("surah")), int(data.get("ayah"))
    except (TypeError, ValueError):
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"ayah": ["حدّد السورة والآية."]}) from None
    if not 1 <= s <= 114 or not 1 <= a <= HAFS_AYAH_COUNTS[s - 1]:
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"ayah": ["هذه الآية غير موجودة في السورة."]})
    return s, a


def _bm(b: Bookmark) -> dict:
    return {"id": b.id, "surah": b.surah, "ayah": b.ayah, "label": b.label, "created_at": b.created_at.isoformat()}


class ReadingPositionView(APIView):
    """The last place this user read, so the Mushaf reopens there on any device."""

    def get(self, request):
        p = ReadingPosition.objects.filter(user=request.user).first()
        if p is None:
            return Response({"surah": None, "ayah": None, "updated_at": None})  # never read yet
        return Response({"surah": p.surah, "ayah": p.ayah, "updated_at": p.updated_at.isoformat()})

    def put(self, request):
        s, a = _ref(request.data)
        p, _ = ReadingPosition.objects.update_or_create(user=request.user, defaults={"surah": s, "ayah": a})
        return Response({"surah": p.surah, "ayah": p.ayah, "updated_at": p.updated_at.isoformat()})


class BookmarkList(APIView):
    def get(self, request):
        return Response([_bm(b) for b in Bookmark.objects.filter(user=request.user)[:500]])

    def post(self, request):
        s, a = _ref(request.data)
        label = str(request.data.get("label", "")).strip()[:80]
        if Bookmark.objects.filter(user=request.user).count() >= 500:
            raise ApiError("too_many", "وصلت إلى الحد الأقصى للعلامات (500).", 409)
        b, created = Bookmark.objects.get_or_create(user=request.user, surah=s, ayah=a, defaults={"label": label})
        return Response(_bm(b), status=201 if created else 200)


class BookmarkDetail(APIView):
    def _get(self, request, pk) -> Bookmark:
        b = Bookmark.objects.filter(pk=pk, user=request.user).first()  # someone else's bookmark is simply not found
        if b is None:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        return b

    def patch(self, request, pk):
        b = self._get(request, pk)
        b.label = str(request.data.get("label", "")).strip()[:80]
        b.save(update_fields=["label"])
        return Response(_bm(b))

    def delete(self, request, pk):
        self._get(request, pk).delete()
        return Response(status=204)


class SurahAudio(APIView):
    """Ayah audio URLs for one surah from the licensed source (Quran Foundation / Quran.com). Signed-in users only,
    so the server is not an open proxy; the URL list is cached for a day."""

    throttle_scope = "quran_audio"

    def get(self, request, number):
        from django.conf import settings

        from . import qf_audio

        if not 1 <= number <= 114:
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        raw = request.query_params.get("reciter", "")
        rid = int(raw) if raw.isdigit() else settings.QF_RECITATION_ID
        if rid not in qf_audio.reciter_ids():
            raise ApiError("invalid", "قارئ غير متاح.", 400, {"reciter": ["اختر قارئًا من القائمة."]})
        try:
            files = qf_audio.surah_audio(number, rid)
        except qf_audio.AudioUnavailable:
            raise ApiError("audio_unavailable", "التلاوة غير متاحة الآن. حاول بعد قليل.", 503) from None
        if not files:
            msg = ("التلاوة متاحة حاليًا للفاتحة والبقرة فقط حتى تكتمل الموافقة على المصدر."
                   if settings.QF_ENV == "prelive" else "لا تتوفر تلاوة لهذه السورة من المصدر.")
            raise ApiError("audio_not_available_for_surah", msg, 404)
        return Response({"surah": number, "reciter_id": rid, "reciter": dict(settings.QF_RECITERS).get(rid, ""), "source": "Quran.com (Quran Foundation)",
                         "ayahs": {str(k): v for k, v in sorted(files.items())}})
