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
if IS_DEPLOYED and not ALLOWED_HOSTS:
    raise ImproperlyConfigured("DJANGO_ALLOWED_HOSTS is required in staging and production.")


def parse_database_url(url: str) -> dict:
    u = urlparse(url)
    if u.scheme not in {"postgres", "postgresql"}:
        raise ImproperlyConfigured("DATABASE_URL must be a PostgreSQL URL (postgres://…). SQLite is not supported.")
    opts = {k: v[-1] for k, v in parse_qs(u.query).items()}
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
    "django.contrib.auth.hashers.Argon2PasswordHasher",
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

# ---- Sessions, CSRF, CORS ------------------------------------------------------------
SESSION_COOKIE_AGE = int(env("SESSION_COOKIE_AGE", str(14 * 24 * 3600)) or 0)
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"
CSRF_TRUSTED_ORIGINS = env_list("CSRF_TRUSTED_ORIGINS", "" if IS_DEPLOYED else "http://localhost:5173,http://localhost:4173")
CORS_ALLOWED_ORIGINS = env_list("CORS_ALLOWED_ORIGINS", "" if IS_DEPLOYED else "http://localhost:5173,http://localhost:4173")
# The Android app (Capacitor serves from https://localhost) authenticates with bearer tokens, not cookies.
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
    },
    "EXCEPTION_HANDLER": "apps.core.exceptions.api_exception_handler",
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "TEST_REQUEST_DEFAULT_FORMAT": "json",
}
if DEBUG:
    REST_FRAMEWORK["DEFAULT_RENDERER_CLASSES"].append("rest_framework.renderers.BrowsableAPIRenderer")

# Bearer tokens for native clients (Android).
NATIVE_TOKEN_TTL_DAYS = int(env("NATIVE_TOKEN_TTL_DAYS", "30") or 30)

CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
if env("REDIS_URL"):
    CACHES = {"default": {"BACKEND": "django.core.cache.backends.redis.RedisCache", "LOCATION": env("REDIS_URL")}}

EMAIL_BACKEND = env("EMAIL_BACKEND", "django.core.mail.backends.console.EmailBackend")
DEFAULT_FROM_EMAIL = env("DEFAULT_FROM_EMAIL", "noreply@halqa.app")
FRONTEND_URL = env("FRONTEND_URL", "http://localhost:5173")

APP_VERSION = env("APP_VERSION", "0.1.0")

# ---- Private media (recitations, voice feedback) --------------------------------------
# "s3": any S3-compatible bucket (Cloudflare R2 proposed). Required in staging/production.
# "local": files under MEDIA_LOCAL_ROOT, development/test only (never served publicly; reads go
# through short-lived signed URLs checked by the API).
MEDIA_STORAGE = env("MEDIA_STORAGE", "s3" if IS_DEPLOYED else "local")
if MEDIA_STORAGE not in {"s3", "local"}:
    raise ImproperlyConfigured("MEDIA_STORAGE must be 's3' or 'local'.")
if IS_DEPLOYED and MEDIA_STORAGE != "s3":
    raise ImproperlyConfigured("MEDIA_STORAGE=local is for development only; configure S3-compatible storage.")
MEDIA_LOCAL_ROOT = Path(env("MEDIA_LOCAL_ROOT", str(BASE_DIR / "var" / "private-media")) or "")
STORAGE_ENDPOINT_URL = env("STORAGE_ENDPOINT_URL", "")  # e.g. https://<account>.r2.cloudflarestorage.com
STORAGE_BUCKET = env("STORAGE_BUCKET", "")
STORAGE_REGION = env("STORAGE_REGION", "auto")
STORAGE_ACCESS_KEY_ID = env("STORAGE_ACCESS_KEY_ID", "")
STORAGE_SECRET_ACCESS_KEY = env("STORAGE_SECRET_ACCESS_KEY", "")
MEDIA_URL_TTL_SECONDS = int(env("MEDIA_URL_TTL_SECONDS", "600") or 600)
MEDIA_MAX_BYTES = {"recitation": 25 * 1024 * 1024, "voice_feedback": 10 * 1024 * 1024}
MEDIA_MAX_SECONDS = {"recitation": 20 * 60, "voice_feedback": 5 * 60}
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
