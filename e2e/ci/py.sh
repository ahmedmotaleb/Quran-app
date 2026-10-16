#!/usr/bin/env bash
# Run one of the e2e/ci/*.py helpers in Django's shell against $DATABASE_URL. Usage: e2e/ci/py.sh <file.py>
cd "$(dirname "$0")/../../backend" && "${PYTHON:-python}" manage.py shell < "../e2e/ci/$1" >/dev/null 2>&1
