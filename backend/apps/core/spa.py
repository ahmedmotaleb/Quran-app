"""Serving the built PWA from Django (single origin with the API)."""
from django.conf import settings
from django.http import FileResponse, Http404

NO_CACHE = {"/sw.js", "/index.html", "/manifest.webmanifest", "/registerSW.js", "/admin/index.html", "/admin/manifest.webmanifest"}


def cache_headers(headers, path, url):
    """WhiteNoise hook. The service worker, page and manifest must always be revalidated so updates
    reach users; content-hashed bundles under /assets/ never change and can be cached for a year."""
    if url in NO_CACHE or url.startswith("/workbox-"):
        headers["Cache-Control"] = "no-cache"
    elif url.startswith("/assets/") and any(ch.isdigit() for ch in url):
        headers["Cache-Control"] = "public, max-age=31536000, immutable"
    if url == "/sw.js":
        headers["Service-Worker-Allowed"] = "/"


def index(request, path=""):
    """Any non-API path returns the app shell (client-side screens). /admin/… returns the admin portal's own page,
    which links its own manifest so it installs as a separate app."""
    from django.http import HttpResponseRedirect

    root = settings.WHITENOISE_ROOT
    admin_path = request.path.startswith("/admin/") or request.path == "/admin"
    if settings.PORTAL == "admin" and not admin_path:
        return HttpResponseRedirect("/admin/")  # the admin service shows only the admin portal
    if admin_path and settings.PORTAL != "admin" and settings.ADMIN_URL:
        return HttpResponseRedirect(f"{settings.ADMIN_URL}/admin/")  # the portal's own address (installable app)
    page = "admin/index.html" if admin_path else "index.html"
    if root is None or not (root / page).is_file():
        raise Http404("Frontend build not found.")
    if request.path == "/admin":
        from django.http import HttpResponsePermanentRedirect

        return HttpResponsePermanentRedirect("/admin/")
    resp = FileResponse(open(root / page, "rb"), content_type="text/html; charset=utf-8")
    resp["Cache-Control"] = "no-cache"
    return resp
