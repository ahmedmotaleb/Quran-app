"""
Settings for the الحلقة (HALQA) API. Everything environment-specific comes from environment
variables (see ../.env.example). Production refuses to start with development defaults.
"""
from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent


def env(name: str, default: str | None = None, *, required: bool = False) -> str | None:
    value = os.environ.get(name, default)
    if required and not value:
        raise ImproperlyConfigured(f"Environment variable {name} is required in {APP_ENV}.")
    return value


def env_list(name: str, default: str = "") -> list[str]:
    return [x.strip() for x in (env(name, default) or "").split(",") if x.strip()]


def env_bool(name: str, default: bool = False) -> bool:
    return (env(name, str(default)) or "").lower() in {"1", "true", "yes", "on"}


# development | test | staging | production
APP_ENV = env("APP_ENV", "development")
if APP_ENV not in {"development", "test", "staging", "production"}:
    raise ImproperlyConfigured(f"APP_ENV must be development, test, staging or production (got {APP_ENV!r}).")
IS_DEPLOYED = APP_ENV in {"staging", "production"}

DEBUG = env_bool("DJANGO_DEBUG", default=not IS_DEPLOYED)
if IS_DEPLOYED and DEBUG:
    raise ImproperlyConfigured("DJANGO_DEBUG must be off in staging and production.")

SECRET_KEY = env("DJANGO_SECRET_KEY", required=IS_DEPLOYED) or "dev-only-insecure-key-do-not-use-in-deployments"
if IS_DEPLOYED and (len(SECRET_KEY) < 50 or SECRET_KEY.startswith("dev-only")):
    raise ImproperlyConfigured("DJANGO_SECRET_KEY must be a unique random value of at least 50 characters.")

ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", "" if IS_DEPLOYED else "localhost,127.0.0.1,testserver")
# APP_URL is the public address (e.g. https://halqa-123.europe-west1.run.app); its host is trusted automatically.
APP_URL = env("APP_URL", "").rstrip("/")
APP_HOST = urlparse(APP_URL).hostname or ""
if APP_HOST and APP_HOST not in ALLOWED_HOSTS:
    ALLOWED_HOSTS.append(APP_HOST)
if IS_DEPLOYED and not ALLOWED_HOSTS:
    raise ImproperlyConfigured("DJANGO_ALLOWED_HOSTS is required in staging and production.")


def parse_database_url(url: str) -> dict:
    u = urlparse(url)
    if u.scheme not in {"postgres", "postgresql"}:
        raise ImproperlyConfigured("DATABASE_URL must be a PostgreSQL URL (postgres://…). SQLite is not supported.")
    opts = {k: v[-1] for k, v in parse_qs(u.query).items()}
    # Fail fast with a clear error instead of hanging if the database is unreachable (e.g. a bad host).
    opts.setdefault("connect_timeout", env("DATABASE_CONNECT_TIMEOUT", "10"))
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": unquote(u.path.lstrip("/")),
        "USER": unquote(u.username or ""),
        "PASSWORD": unquote(u.password or ""),
        "HOST": u.hostname or "",
        "PORT": str(u.port or ""),
        "CONN_MAX_AGE": int(env("DATABASE_CONN_MAX_AGE", "60") or 60),
        "CONN_HEALTH_CHECKS": True,
        "OPTIONS": opts,
    }


DATABASES = {"default": parse_database_url(env("DATABASE_URL", required=True) or "")}

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.postgres",
    "corsheaders",
    "rest_framework",
    "apps.core",
    "apps.accounts",
    "apps.quran",
    "apps.media",
    "apps.learning",
    "apps.scheduling",
    "apps.assessments",
    "apps.notifications",
]

MIDDLEWARE = [
    "apps.core.middleware.RequestIdMiddleware",
    "apps.core.middleware.SecurityHeadersMiddleware",
    "apps.core.middleware.HealthCheckMiddleware",  # before Security/Common: platform health checks skip host/HTTPS rules
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
AUTH_USER_MODEL = "accounts.User"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ]
        },
    }
]

# Passwords: Argon2 first; existing hashes upgrade on next login.
PASSWORD_HASHERS = [
    "apps.accounts.hashers.SmallArgon2PasswordHasher",  # Argon2id, OWASP parameters (see the module)
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
]
if APP_ENV == "test":
    # Fast hashing for the test suite only.
    PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 10}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

# Arabic UI; instants stored in UTC, displayed in the user's IANA timezone (default Cairo).
LANGUAGE_CODE = "ar"
TIME_ZONE = env("DEFAULT_TIMEZONE", "Africa/Cairo")
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
# Single-origin deployment: the built PWA (dist/) is served by Django at "/" next to /api, so the
# session cookie is first-party everywhere (Safari blocks third-party cookies).
FRONTEND_DIST = Path(env("FRONTEND_DIST", str(BASE_DIR.parent / "dist")) or "")
WHITENOISE_ROOT = FRONTEND_DIST if FRONTEND_DIST.is_dir() else None
def _whitenoise_headers(headers, path, url):
    from apps.core.spa import cache_headers  # imported lazily: settings load before apps

    cache_headers(headers, path, url)


WHITENOISE_ADD_HEADERS_FUNCTION = _whitenoise_headers

# ---- Sessions, CSRF, CORS ------------------------------------------------------------
SESSION_COOKIE_AGE = int(env("SESSION_COOKIE_AGE", str(14 * 24 * 3600)) or 0)
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"
CSRF_TRUSTED_ORIGINS = env_list("CSRF_TRUSTED_ORIGINS", "" if IS_DEPLOYED else "http://localhost:5173,http://localhost:4173")
if APP_URL and APP_URL not in CSRF_TRUSTED_ORIGINS:
    CSRF_TRUSTED_ORIGINS.append(APP_URL)
CORS_ALLOWED_ORIGINS = env_list("CORS_ALLOWED_ORIGINS", "" if IS_DEPLOYED else "http://localhost:5173,http://localhost:4173")
CORS_ALLOW_CREDENTIALS = True
CORS_ALLOW_HEADERS = ["accept", "authorization", "content-type", "x-csrftoken", "x-request-id", "idempotency-key"]
CORS_EXPOSE_HEADERS = ["x-request-id"]

if IS_DEPLOYED:
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    SECURE_SSL_REDIRECT = env_bool("SECURE_SSL_REDIRECT", True)
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_HSTS_SECONDS = int(env("SECURE_HSTS_SECONDS", "31536000") or 0)
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    # Preload-list submission is hard to undo; the domain owner opts in explicitly.
    SECURE_HSTS_PRELOAD = env_bool("SECURE_HSTS_PRELOAD", False)
    if not SECURE_HSTS_PRELOAD:
        SILENCED_SYSTEM_CHECKS = ["security.W021"]
    SECURE_CONTENT_TYPE_NOSNIFF = True
    SECURE_REFERRER_POLICY = "same-origin"
    X_FRAME_OPTIONS = "DENY"

# ---- API -------------------------------------------------------------------------------
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "apps.accounts.authentication.BearerTokenAuthentication",
        "apps.accounts.authentication.CsrfSessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_PAGINATION_CLASS": "apps.core.pagination.StandardPagination",
    "PAGE_SIZE": 20,
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.ScopedRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {
        "auth": env("THROTTLE_AUTH", "10/min"),
        "recovery": env("THROTTLE_RECOVERY", "5/hour"),
        "booking": env("THROTTLE_BOOKING", "30/min"),
        "upload": env("THROTTLE_UPLOAD", "20/hour"),
        "quran_audio": env("THROTTLE_QURAN_AUDIO", "120/min"),
    },
    "EXCEPTION_HANDLER": "apps.core.exceptions.api_exception_handler",
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "TEST_REQUEST_DEFAULT_FORMAT": "json",
}
if DEBUG:
    REST_FRAMEWORK["DEFAULT_RENDERER_CLASSES"].append("rest_framework.renderers.BrowsableAPIRenderer")

# Bearer tokens for native clients (Android).
NATIVE_TOKEN_TTL_DAYS = int(env("NATIVE_TOKEN_TTL_DAYS", "30") or 30)

# Rate limits and lockouts must be shared by every worker and instance: deployments use a database table
# (created by `createcachetable` during deploy) unless REDIS_URL is set. Per-process memory only in development.
CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
if IS_DEPLOYED:
    CACHES = {"default": {"BACKEND": "django.core.cache.backends.db.DatabaseCache", "LOCATION": "halqa_cache"}}
if env("REDIS_URL"):
    CACHES = {"default": {"BACKEND": "django.core.cache.backends.redis.RedisCache", "LOCATION": env("REDIS_URL")}}

# Web Push (optional): VAPID keys from deploy/gcp-push.sh. Without both keys push stays off (nothing simulated).
VAPID_PUBLIC_KEY = env("VAPID_PUBLIC_KEY", "")
VAPID_PRIVATE_KEY = env("VAPID_PRIVATE_KEY", "")
VAPID_SUBJECT = env("VAPID_SUBJECT", "") or (APP_URL or "mailto:admin@example.invalid")

# Admin accounts must have two-step verification before using admin APIs (default on in staging/production).
ADMIN_REQUIRE_MFA = env_bool("ADMIN_REQUIRE_MFA", IS_DEPLOYED)
LOGIN_LOCKOUT_FAILURES = int(env("LOGIN_LOCKOUT_FAILURES", "10") or 10)  # per account, any IP, within the window
LOGIN_LOCKOUT_MINUTES = int(env("LOGIN_LOCKOUT_MINUTES", "15") or 15)

# SMTP when EMAIL_HOST is set (e.g. a free transactional-email plan); otherwise mail is only logged.
EMAIL_HOST = env("EMAIL_HOST", "")
EMAIL_PORT = int(env("EMAIL_PORT", "587") or 587)
EMAIL_HOST_USER = env("EMAIL_HOST_USER", "")
EMAIL_HOST_PASSWORD = env("EMAIL_HOST_PASSWORD", "")
EMAIL_USE_TLS = env_bool("EMAIL_USE_TLS", True)
EMAIL_TIMEOUT = 10
# Without a provider: development prints mail to the console; deployments never log message bodies (they contain
# reset links), they only record that nothing was sent (apps.core.mail.SuppressedBackend).
EMAIL_BACKEND = env("EMAIL_BACKEND", "django.core.mail.backends.smtp.EmailBackend" if EMAIL_HOST else (
    "apps.core.mail.SuppressedBackend" if IS_DEPLOYED else "django.core.mail.backends.console.EmailBackend"))
DEFAULT_FROM_EMAIL = env("DEFAULT_FROM_EMAIL", "") or "noreply@halqa.app"  # empty env var = default
EMAIL_FILE_PATH = env("EMAIL_FILE_PATH", "")  # end-to-end tests: EMAIL_BACKEND=...filebased.EmailBackend writes here
FRONTEND_URL = env("FRONTEND_URL", APP_URL or "http://localhost:5173")  # password-reset links

APP_VERSION = env("APP_VERSION", "0.1.0")

# ---- Private media (recitations, voice feedback) --------------------------------------
# "s3": any S3-compatible bucket (Cloudflare R2 proposed). Required in staging/production.
# "local": files under MEDIA_LOCAL_ROOT, development/test only (never served publicly; reads go
# through short-lived signed URLs checked by the API).
# "none": no storage configured yet — the app runs, and uploads answer 503 "storage not configured"
# instead of pretending to succeed (the default in deployments until STORAGE_* are set).
MEDIA_STORAGE = env("MEDIA_STORAGE", ("s3" if env("STORAGE_BUCKET") else "none") if IS_DEPLOYED else "local")
if MEDIA_STORAGE not in {"s3", "local", "none"}:
    raise ImproperlyConfigured("MEDIA_STORAGE must be 's3', 'local' or 'none'.")
if IS_DEPLOYED and MEDIA_STORAGE == "local":
    raise ImproperlyConfigured("MEDIA_STORAGE=local is for development only; configure S3-compatible storage.")
MEDIA_LOCAL_ROOT = Path(env("MEDIA_LOCAL_ROOT", str(BASE_DIR / "var" / "private-media")) or "")
STORAGE_ENDPOINT_URL = env("STORAGE_ENDPOINT_URL", "")  # e.g. https://<account>.r2.cloudflarestorage.com
STORAGE_BUCKET = env("STORAGE_BUCKET", "")
STORAGE_REGION = env("STORAGE_REGION", "auto")
STORAGE_ACCESS_KEY_ID = env("STORAGE_ACCESS_KEY_ID", "")
STORAGE_SECRET_ACCESS_KEY = env("STORAGE_SECRET_ACCESS_KEY", "")
MEDIA_URL_TTL_SECONDS = int(env("MEDIA_URL_TTL_SECONDS", "600") or 600)
MEDIA_MAX_BYTES = {"recitation": 25 * 1024 * 1024, "voice_feedback": 10 * 1024 * 1024, "lesson_file": 50 * 1024 * 1024}
# Student recordings are deleted this long after the teacher reviewed them (owner decision).
RECORDING_RETENTION_HOURS = int(os.environ.get("RECORDING_RETENTION_HOURS", "48"))
# Reference recitation audio for the Mushaf (pack prompt 21). Off until the owner has a licence or written permission
# for a source. AYAH_AUDIO_URL is an https template with {surah} and {ayah} (zero-padded to 3 digits), e.g.
# https://everyayah.com/data/Alafasy_128kbps/{surah}{ayah}.mp3 ; AYAH_AUDIO_NAME is the credit shown under the text.
AYAH_AUDIO_URL = os.environ.get("AYAH_AUDIO_URL", "").strip()
AYAH_AUDIO_NAME = os.environ.get("AYAH_AUDIO_NAME", "").strip()
if AYAH_AUDIO_URL and not (AYAH_AUDIO_URL.startswith("https://") and "{surah}" in AYAH_AUDIO_URL and "{ayah}" in AYAH_AUDIO_URL):
    raise ImproperlyConfigured("AYAH_AUDIO_URL must be an https URL containing {surah} and {ayah}.")
# Licensed source (owner decision, 17 October 2026): Quran Foundation Content API (Quran.com). The server gets the
# ayah audio URLs with OAuth2 client credentials (the secret never reaches browsers); browsers stream the files from
# Quran Foundation's CDN. Terms: in-app use allowed; cache at most 1 week (we keep URL lists 1 day); credit QF.
# QF_ENV=prelive serves only Al-Fatihah and Al-Baqarah until production access is approved.
QF_CLIENT_ID = os.environ.get("QF_CLIENT_ID", "").strip()
QF_CLIENT_SECRET = os.environ.get("QF_CLIENT_SECRET", "").strip()
QF_ENV = os.environ.get("QF_ENV", "prelive").strip() or "prelive"
if QF_ENV not in ("prelive", "production"):
    raise ImproperlyConfigured("QF_ENV must be prelive or production.")
# Reciters offered in the Mushaf (Quran Foundation recitation ids). The first is the default (owner, 22 October 2026:
# Sheikh al-Husary's teaching Mushaf). QF_RECITERS="12:name;7:name" replaces the list without a code change.
QF_RECITERS = [(12, "محمود خليل الحصري — المصحف المعلم"), (7, "مشاري راشد العفاسي")]
if os.environ.get("QF_RECITERS", "").strip():
    QF_RECITERS = [(int(i), n.strip()) for i, _, n in (x.partition(":") for x in os.environ["QF_RECITERS"].split(";")) if i.strip().isdigit()]
QF_RECITATION_ID = int(os.environ.get("QF_RECITATION_ID", "") or QF_RECITERS[0][0])  # the default reciter
QF_RECITER_NAME = dict(QF_RECITERS).get(QF_RECITATION_ID, os.environ.get("QF_RECITER_NAME", "").strip())
# Quran.com serves some recitations (e.g. al-Husary's Muallim) from its quranicaudio mirrors.
QF_AUDIO_HOSTS = ("verses.quran.foundation", "verses.quran.com", "download.quranicaudio.com", "mirrors.quranicaudio.com")
MEDIA_MAX_SECONDS = {"recitation": 20 * 60, "voice_feedback": 5 * 60, "lesson_file": 4 * 3600}
FILE_UPLOAD_MAX_MEMORY_SIZE = 2 * 1024 * 1024  # larger uploads spool to a temp file

# ---- Logging: one JSON object per line, with the request id --------------------------
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {"request_id": {"()": "apps.core.logging.RequestIdFilter"}},
    "formatters": {"json": {"()": "apps.core.logging.JsonFormatter"}},
    "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "json", "filters": ["request_id"]}},
    "root": {"handlers": ["console"], "level": env("LOG_LEVEL", "INFO")},
    "loggers": {"django.db.backends": {"level": "WARNING"}},
}
