from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from apps.quran.importer import ImportErrorList, import_source, parse_metadata, parse_tanzil, verify_source
from apps.quran.models import QuranSource


class Command(BaseCommand):
    help = "Import (or --verify) a Tanzil Quran text file. Download it from https://tanzil.net/download/ (Uthmani, text with aya numbers)."

    def add_arguments(self, p):
        p.add_argument("file", type=Path)
        p.add_argument("--metadata", type=Path, help="Tanzil quran-data.xml for surah names")
        p.add_argument("--slug", default="tanzil-uthmani")
        p.add_argument("--version", required=False, default="")
        p.add_argument("--activate", action="store_true")
        p.add_argument("--verify", action="store_true", help="Compare an existing import with the file instead of importing")

    def handle(self, file, metadata, slug, version, activate, verify, **_):
        raw = file.read_bytes()
        try:
            if verify:
                src = QuranSource.objects.get(slug=slug)
                problems = verify_source(src, raw)
                if problems:
                    raise CommandError("Integrity check FAILED:\n" + "\n".join(problems[:50]))
                self.stdout.write(self.style.SUCCESS(f"{slug}: all {src.ayahs.count()} ayahs match (sha256 {src.sha256[:12]}…)"))
                return
            if not version:
                raise CommandError("--version is required (the Tanzil version shown in the file header)")
            parsed = parse_tanzil(raw)
            meta = parse_metadata(metadata.read_bytes() if metadata else None)
            src = import_source(parsed=parsed, slug=slug, name="Tanzil Quran Text", edition="Uthmani", version=version,
                                source_url="https://tanzil.net", license_name="Tanzil Quran Text License (CC BY 3.0)",
                                meta=meta, activate=activate)
        except ImportErrorList as e:
            raise CommandError("Import rejected:\n" + "\n".join(e.errors[:50]))
        self.stdout.write(self.style.SUCCESS(f"Imported {src.ayahs.count()} ayahs as {src.slug} (sha256 {src.sha256[:12]}…, active={src.is_active})"))
