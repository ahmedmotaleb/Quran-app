from django.conf import settings
from django.contrib import admin
from django.urls import include, path, re_path

from apps.core import spa, views as core

urlpatterns = [
    path("api/health", core.health),
    path("api/ready", core.ready),
    path("api/v1/", include("config.api_urls")),
]
# The Django admin site is an operations tool, not the product admin portal.
if settings.DEBUG or settings.APP_ENV == "staging":
    urlpatterns.append(path("ops-admin/", admin.site.urls))

# The PWA shell for every other path (deep links, refreshes). Static files themselves are served by WhiteNoise.
if settings.WHITENOISE_ROOT is not None:
    urlpatterns.append(re_path(r"^(?!api/|ops-admin/).*$", spa.index))
