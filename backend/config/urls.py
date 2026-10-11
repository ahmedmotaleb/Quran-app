from django.conf import settings
from django.contrib import admin
from django.urls import include, path

from apps.core import views as core

urlpatterns = [
    path("api/health", core.health),
    path("api/ready", core.ready),
    path("api/v1/", include("config.api_urls")),
]
# The Django admin site is an operations tool, not the product admin portal.
if settings.DEBUG or settings.APP_ENV == "staging":
    urlpatterns.append(path("ops-admin/", admin.site.urls))
