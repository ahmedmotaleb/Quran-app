#!/bin/sh
# Container entrypoint. The web server binds its port immediately (hosts like Render fail the deploy if
# no port opens in time); database migrations run alongside it. Until they finish, /api/ready answers
# 503 with the reason, and a database error is printed here instead of hanging the boot.
# Small instances (512 MB): 2 workers x 4 threads.
set -e
(
  echo "start: applying database migrations"
  if python manage.py migrate --noinput; then
    echo "start: migrations done"
  else
    echo "start: MIGRATIONS FAILED - check DATABASE_URL (see /api/ready)"
  fi
) &
echo "start: web server on port ${PORT:-10000}"
exec gunicorn config.wsgi:application --bind "0.0.0.0:${PORT:-10000}" \
  --workers "${WEB_CONCURRENCY:-2}" --threads 4 --timeout 120 --access-logfile - --forwarded-allow-ips '*'
