"""Serving the built PWA from Django (single origin with the API)."""
from django.conf import settings
from django.http import FileResponse, Http404

NO_CACHE = {"/sw.js", "/index.html", "/manifest.webmanifest", "/registerSW.js"}


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
    """Any non-API path returns the app shell (client-side screens)."""
    root = settings.WHITENOISE_ROOT
    if root is None or not (root / "index.html").is_file():
        raise Http404("Frontend build not found.")
    resp = FileResponse(open(root / "index.html", "rb"), content_type="text/html; charset=utf-8")
    resp["Cache-Control"] = "no-cache"
    return resp
