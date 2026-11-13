"""Fill «الأذكار والأدعية»: the proposed Quranic references (text from the verified Quran text) and the Sunnah entries
of data/sunnah_adhkar.json (copied verbatim from the hadith dataset, graded صحيح/حسن). Idempotent.
--approve publishes the PENDING entries that came from these two lists (owner request, 13 Nov 2026); entries an
administrator rejected or added are never touched. Logs one `adhkar_library` line (read by the ops workflow)."""
import json
import logging

from django.core.management.base import BaseCommand

log = logging.getLogger("halqa.ops")


class Command(BaseCommand):
    help = "Add the verified Quran and Sunnah adhkar (pending), optionally approving them."

    def add_arguments(self, p):
        p.add_argument("--approve", action="store_true")

    def handle(self, approve=False, **_):
        from django.db.models import Count

        from apps.core.audit import audit
        from apps.adhkar.models import Dhikr
        from apps.adhkar.seed import approve_library, seed_quran, seed_sunnah

        r = {"quran": seed_quran(), "sunnah": seed_sunnah(), "approved": 0}
        if approve:
            r["approved"] = approve_library("اعتماد بطلب المالك: نص القرآن من النص المعتمد، ونص الحديث منقول حرفيًا من مصدره ودرجته صحيح/حسن")
        r["library"] = dict(Dhikr.objects.values_list("status").annotate(n=Count("id")))
        r["approved_by_category"] = dict(Dhikr.objects.filter(status="approved", enabled=True).values_list("category").annotate(n=Count("id")))
        audit("adhkar.library_loaded", actor=None, target=None, quran=r["quran"]["created"], sunnah=r["sunnah"]["created"], approved=r["approved"])
        log.warning("adhkar_library", extra={"report": json.dumps(r, ensure_ascii=False)})
        self.stdout.write(json.dumps(r, ensure_ascii=False))
