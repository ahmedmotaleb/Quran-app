#!/usr/bin/env bash
# Import the verified Quran text once and save it as backend/quran-data.sql (restored after every reseed).
set -euo pipefail
cd "$(dirname "$0")/../../backend"
curl -sSL -A "halqa-e2e (+https://github.com/ahmedmotaleb/Quran-app)" -o /tmp/quran.txt \
  "https://tanzil.net/pub/download/index.php?marks=true&sajdah=true&rub=false&tatweel=true&quranType=uthmani&outType=txt-2&agree=true"
curl -sSL -o /tmp/quran-data.xml https://tanzil.net/res/text/metadata/quran-data.xml
"${PYTHON:-python}" manage.py import_quran /tmp/quran.txt --metadata /tmp/quran-data.xml --source-version e2e --activate | tail -1
pg_dump --data-only --no-owner --table 'quran_*' "$DATABASE_URL" > quran-data.sql
echo "snapshot: $(grep -c '^COPY' quran-data.sql) tables"
