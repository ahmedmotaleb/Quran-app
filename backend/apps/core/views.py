import logging

from django.conf import settings
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

log = logging.getLogger(__name__)


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def health(request):
    """Liveness: the process is up. Discloses no configuration."""
    return Response({"status": "ok", "version": settings.APP_VERSION})


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def ready(request):
    """Readiness: database reachable and all migrations applied."""
    from apps.media.storage import storage_status

    checks = {}
    try:
        with connection.cursor() as c:
            c.execute("SELECT 1")
        checks["database"] = "ok"
        executor = MigrationExecutor(connection)
        pending = executor.migration_plan(executor.loader.graph.leaf_nodes())
        checks["migrations"] = "ok" if not pending else f"{len(pending)} pending"
    except Exception as e:  # noqa: BLE001 — report a category, never the error text (it can contain hosts/users)
        checks.setdefault("database", "unavailable: " + _db_problem(str(e)))
    if checks.get("database") == "ok":
        # Sign-in limits and lockouts live in the shared cache (a database table when deployed): without it every
        # sign-in would fail, so readiness must say so.
        from django.core.cache import cache
        from django.db import transaction

        try:
            with transaction.atomic():  # a savepoint: a missing table must not break the queries below
                cache.get("ready-probe")
            checks["cache"] = "ok"
        except Exception:  # noqa: BLE001
            checks["cache"] = "unavailable: run `python manage.py createcachetable`"
    ok = all(v == "ok" for v in checks.values())
    if not ok:
        log.error("ready_check_failed", extra={"checks": checks})
    # What still needs owner configuration (informational; does not affect readiness).
    features = {
        "media_storage": storage_status(),
        "email": "smtp" if "smtp" in settings.EMAIL_BACKEND else "log_only",
        "push": "configured" if settings.VAPID_PUBLIC_KEY and settings.VAPID_PRIVATE_KEY else "not_configured",
        "ayah_audio": (f"quran_foundation_{settings.QF_ENV}" if settings.QF_CLIENT_ID and settings.QF_CLIENT_SECRET
                       else "template" if settings.AYAH_AUDIO_URL else "off"),
    }
    if checks.get("database") == "ok":
        from apps.quran.models import QuranSource

        features["quran_text"] = "imported" if QuranSource.objects.filter(is_active=True).exists() else "not_imported"
    return Response({"status": "ok" if ok else "unavailable", "checks": checks, "features": features}, status=200 if ok else 503)


def _db_problem(msg: str) -> str:
    m = msg.lower()
    for needle, label in (("password authentication failed", "wrong password or user in DATABASE_URL"),
                          ("could not translate host name", "unknown host in DATABASE_URL"),
                          ("name or service not known", "unknown host in DATABASE_URL"),
                          ("timeout", "connection timed out (check host/region, pooling off)"),
                          ("does not exist", "database name in DATABASE_URL does not exist"),
                          ("ssl", "SSL problem (add ?sslmode=require)"),
                          ("connection refused", "connection refused")):
        if needle in m:
            return label
    return "cannot connect"
