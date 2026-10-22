"""Production check of the licensed recitation source (Ops -> audio-check): asks Quran Foundation for one surah's
ayah audio list, bypassing the cache, and logs the outcome as one line (no credentials, no URLs)."""
import logging

from django.conf import settings
from django.core.cache import cache
from django.core.management.base import BaseCommand, CommandError

from apps.quran import qf_audio

log = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Check that ayah audio can be fetched from Quran Foundation."

    def add_arguments(self, parser):
        parser.add_argument("--surah", type=int, default=1)
        parser.add_argument("--recitation", type=int, default=0, help="one recitation id; default: every offered reciter")

    def handle(self, *args, surah, recitation, **opts):
        if not qf_audio.configured():
            log.warning("qf_audio_check", extra={"result": "not_configured"})
            raise CommandError("Quran Foundation keys are not configured.")
        ids = [recitation] if recitation else qf_audio.reciter_ids()
        bad = []
        for rid in ids:
            cache.delete(f"qf:audio:{settings.QF_ENV}:{rid}:{surah}")
            try:
                files = qf_audio.surah_audio(surah, rid)
            except (qf_audio.AudioUnavailable, ValueError):
                log.error("qf_audio_check", extra={"result": "failed", "env": settings.QF_ENV, "surah": surah, "recitation": rid})
                bad.append(rid)
                continue
            hosts = sorted({u.split("/")[2] for u in files.values()})
            log.info("qf_audio_check", extra={"result": "ok" if files else "empty", "env": settings.QF_ENV, "surah": surah,
                                              "recitation": rid, "ayahs": len(files), "hosts": ",".join(hosts)})
            self.stdout.write(f"recitation {rid}, surah {surah}: {len(files)} ayah audio files ({settings.QF_ENV}) from {', '.join(hosts) or '-'}")
            if not files:
                bad.append(rid)
        if bad:
            raise CommandError(f"No audio for recitation(s) {bad}; see the qf_audio_check / qf_request_failed log lines.")
