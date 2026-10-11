# الحلقة API (Django)

Django 5.2 LTS + Django REST Framework 3.18 + PostgreSQL 16, Python 3.13. One API serves
the web app, the admin portal and the Android app.

## Local setup

```bash
# PostgreSQL 16 running locally; create a dev-only role and database
sudo -u postgres psql -c "CREATE ROLE halqa LOGIN PASSWORD 'halqa-dev-only' CREATEDB;"
sudo -u postgres psql -c "CREATE DATABASE halqa_dev OWNER halqa;"

cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
export DATABASE_URL=postgres://halqa:halqa-dev-only@localhost:5432/halqa_dev
.venv/bin/python manage.py migrate
.venv/bin/python manage.py seed_dev          # dev/test only; refuses in staging/production
.venv/bin/python manage.py runserver 8000
curl localhost:8000/api/ready                # {"status":"ok","checks":{"database":"ok","migrations":"ok"}}
```

Seeded accounts (password `halqa123`, or `SEED_PASSWORD`): `admin@halqa.app`,
`teacher@halqa.app`, `khalid@halqa.app`, `yousef@halqa.app`, `sara@halqa.app`,
`parent@halqa.app`. These exist only in development and test databases.

## Tests

```bash
APP_ENV=test DATABASE_URL=… .venv/bin/pytest -p no:warnings --create-db
```

The suite runs on PostgreSQL (never SQLite). It covers concurrent booking, permission
isolation, auth flows, Quran import integrity and database constraints. CI runs it on every
push (`.github/workflows/backend.yml`).

## Configuration

All configuration comes from environment variables, listed in `../.env.example`. With
`APP_ENV=staging|production` the app refuses to start without a strong
`DJANGO_SECRET_KEY` and `DJANGO_ALLOWED_HOSTS`, or with `DEBUG` on. It also enables HTTPS
redirect, secure cookies and HSTS. Check a production configuration with
`python manage.py check --deploy`.

## Quran text

Download the Tanzil Uthmani text ("Text with aya numbers") and, optionally,
`quran-data.xml` from https://tanzil.net/download/. Then:

```bash
python manage.py import_quran quran-uthmani.txt --metadata quran-data.xml --version 1.1 --activate
python manage.py import_quran quran-uthmani.txt --verify      # byte-for-byte integrity check
```

The import is rejected unless all 114 surahs have exactly the Hafs ayah counts (6,236 in
total). The file's SHA-256 and its license notice are stored and served at
`/api/v1/quran/source`. A new version needs a new `--slug`; existing text is never
overwritten.

## Layout

```
config/           settings (env-driven), URLs
apps/core/        request ids, JSON logs, Arabic error format, health/ready, audit log, app settings, seed_dev
apps/accounts/    users & roles, profiles, teacher assignments, guardian links, invitations, tokens, MFA, permissions
apps/quran/       versioned Quran source, surahs, ayahs, importer
apps/learning/    courses, lessons, enrollments, assignments (+history), submissions, feedback
apps/scheduling/  availability rules/exceptions, circles, session occurrences, bookings, attendance
apps/assessments/ tests, versioned questions, attempts, answers
apps/media/       media metadata (bytes live in object storage)
apps/notifications/ in-app notifications
```

See `../docs/API.md` for endpoints, permissions and status transitions.
