#!/bin/sh
# Container entrypoint: apply migrations, then serve. Small instances (512 MB): 2 workers × 4 threads.
set -e
python manage.py migrate --noinput
exec gunicorn config.wsgi:application --bind "0.0.0.0:${PORT:-10000}" \
  --workers "${WEB_CONCURRENCY:-2}" --threads 4 --timeout 120 --access-logfile - --forwarded-allow-ips '*'
