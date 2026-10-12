from django.conf import settings
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response


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
    ok = all(v == "ok" for v in checks.values())
    # What still needs owner configuration (informational; does not affect readiness).
    features = {
        "media_storage": "configured" if settings.MEDIA_STORAGE != "none" else "not_configured",
        "email": "smtp" if "smtp" in settings.EMAIL_BACKEND else "log_only",
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
