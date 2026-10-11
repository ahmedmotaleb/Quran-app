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
    except Exception:  # noqa: BLE001 — report state, never the error text
        checks.setdefault("database", "unavailable")
    ok = all(v == "ok" for v in checks.values())
    return Response({"status": "ok" if ok else "unavailable", "checks": checks}, status=200 if ok else 503)
