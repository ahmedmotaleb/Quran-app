"""RFC 6238 TOTP (SHA-1, 30 s, 6 digits) for admin MFA — compatible with standard authenticator apps."""
import base64
import hmac
import secrets
import struct
import time
from hashlib import sha1
from urllib.parse import quote


def new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _code(secret: str, counter: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    digest = hmac.new(key, struct.pack(">Q", counter), sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return f"{value % 1_000_000:06d}"


def verify(secret: str, code: str, *, at: float | None = None, window: int = 1) -> bool:
    code = (code or "").strip()
    if not secret or len(code) != 6 or not code.isdigit():
        return False
    counter = int((at or time.time()) // 30)
    return any(hmac.compare_digest(_code(secret, counter + d), code) for d in range(-window, window + 1))


def provisioning_uri(secret: str, email: str, issuer: str = "HALQA Admin") -> str:
    return f"otpauth://totp/{quote(issuer)}:{quote(email)}?secret={secret}&issuer={quote(issuer)}&digits=6&period=30"
