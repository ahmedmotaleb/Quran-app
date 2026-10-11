"""
Private object storage. Two backends with the same small interface:

- S3Storage: any S3-compatible bucket (Cloudflare R2 proposed). The bucket must be private;
  reads use presigned GET URLs that expire after MEDIA_URL_TTL_SECONDS.
- LocalStorage: development/test only (settings refuse it in staging/production). Files live
  outside any static/media URL; reads go through /api/v1/media/<id>/content with a signed,
  expiring token.
"""
from __future__ import annotations

import functools
import shutil
from datetime import datetime, timedelta, timezone as dt_tz
from pathlib import Path
from typing import BinaryIO

from django.conf import settings
from django.core import signing
from django.core.exceptions import ImproperlyConfigured
from django.urls import reverse

SIGNING_SALT = "halqa.media.read"


class StorageError(Exception):
    pass


class LocalStorage:
    name = "local"

    def __init__(self, root: Path):
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if self.root.resolve() not in p.parents:
            raise StorageError("invalid key")
        return p

    def save(self, key: str, fileobj: BinaryIO, content_type: str) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "wb") as out:
            shutil.copyfileobj(fileobj, out)

    def open(self, key: str) -> BinaryIO:
        return open(self._path(key), "rb")

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def read_url(self, key: str, *, media_id: str, request=None) -> tuple[str, datetime]:
        token = signing.dumps({"m": media_id}, salt=SIGNING_SALT)
        path = reverse("media-content", args=[media_id]) + f"?t={token}"
        url = request.build_absolute_uri(path) if request is not None else path
        return url, datetime.now(dt_tz.utc) + timedelta(seconds=settings.MEDIA_URL_TTL_SECONDS)


class S3Storage:
    name = "s3"

    def __init__(self):
        missing = [n for n in ("STORAGE_BUCKET", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY") if not getattr(settings, n)]
        if missing:
            raise ImproperlyConfigured(f"Object storage is not configured: missing {', '.join(missing)}.")
        import boto3
        from botocore.config import Config

        self.bucket = settings.STORAGE_BUCKET
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.STORAGE_ENDPOINT_URL or None,
            region_name=settings.STORAGE_REGION or None,
            aws_access_key_id=settings.STORAGE_ACCESS_KEY_ID,
            aws_secret_access_key=settings.STORAGE_SECRET_ACCESS_KEY,
            config=Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}, connect_timeout=5, read_timeout=30),
        )

    def save(self, key: str, fileobj: BinaryIO, content_type: str) -> None:
        try:
            self.client.upload_fileobj(fileobj, self.bucket, key, ExtraArgs={"ContentType": content_type})
        except Exception as e:  # noqa: BLE001 — surfaced as a clean API error
            raise StorageError(str(e)) from e

    def open(self, key: str) -> BinaryIO:
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"]

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=key)

    def read_url(self, key: str, *, media_id: str, request=None) -> tuple[str, datetime]:
        ttl = settings.MEDIA_URL_TTL_SECONDS
        url = self.client.generate_presigned_url("get_object", Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=ttl)
        return url, datetime.now(dt_tz.utc) + timedelta(seconds=ttl)


@functools.cache
def get_storage() -> LocalStorage | S3Storage:
    if settings.MEDIA_STORAGE == "local":
        return LocalStorage(settings.MEDIA_LOCAL_ROOT)
    return S3Storage()


def verify_read_token(token: str, media_id: str) -> bool:
    try:
        data = signing.loads(token, salt=SIGNING_SALT, max_age=settings.MEDIA_URL_TTL_SECONDS)
    except signing.BadSignature:
        return False
    return data.get("m") == media_id
