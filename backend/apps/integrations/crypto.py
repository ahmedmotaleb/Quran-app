"""Teachers' Google refresh tokens are encrypted at rest (Fernet: AES-128-CBC + HMAC-SHA256).

Key: GOOGLE_TOKEN_KEY (Secret Manager) when set; otherwise derived from DJANGO_SECRET_KEY (also in Secret Manager)
with HKDF, so a database copy alone never reveals a token. Rotating either key means teachers reconnect once."""
import base64

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from django.conf import settings


def _fernet() -> Fernet:
    if settings.GOOGLE_TOKEN_KEY:
        return Fernet(settings.GOOGLE_TOKEN_KEY.encode())
    raw = HKDF(algorithm=hashes.SHA256(), length=32, salt=b"halqa-google-calendar", info=b"refresh-token-v1").derive(settings.SECRET_KEY.encode())
    return Fernet(base64.urlsafe_b64encode(raw))


def encrypt(token: str) -> str:
    return _fernet().encrypt(token.encode()).decode()


def decrypt(blob: str) -> str | None:
    """None when the blob cannot be read (key rotated or data damaged): the teacher must reconnect."""
    try:
        return _fernet().decrypt(blob.encode()).decode()
    except (InvalidToken, ValueError):
        return None
