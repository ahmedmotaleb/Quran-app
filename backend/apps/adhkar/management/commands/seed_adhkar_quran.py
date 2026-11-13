"""Add the proposed Quranic references (text copied from the verified Quran text), all pending review."""
import json

from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Create the proposed Quranic adhkar/dua entries (pending review)."

    def handle(self, **_):
        from apps.adhkar.seed import seed_quran

        self.stdout.write(json.dumps(seed_quran(), ensure_ascii=False))
