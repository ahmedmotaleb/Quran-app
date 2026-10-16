"""Meeting providers for live sessions (pack prompt 19). The first adapter is "a meeting link the teacher pastes":
no custom video, no provider credentials on our server. Only https links on known meeting hosts are accepted, and
links that carry a host credential (a Zoom start link, a sign-in token, user:password@) are refused, so a student
can never receive the teacher's host access. Adding Zoom/Meet APIs later means a new adapter, not new fields."""
from urllib.parse import parse_qs, urlsplit

# provider -> hosts (exact, or any subdomain of them)
PROVIDERS = {
    "google_meet": ("meet.google.com",),
    "zoom": ("zoom.us",),
    "jitsi": ("meet.jit.si",),
    "teams": ("teams.microsoft.com", "teams.live.com"),
}
LABELS = {"google_meet": "Google Meet", "zoom": "Zoom", "jitsi": "Jitsi Meet", "teams": "Microsoft Teams"}
# Query keys that carry host or sign-in credentials in these providers' links.
HOST_SECRETS = {"zak", "token", "tk", "access_token", "jwt"}


class InvalidMeetingLink(ValueError):
    pass


def provider_for(url: str) -> str:
    """Returns the provider key for an acceptable join link, or raises InvalidMeetingLink with an Arabic message."""
    url = (url or "").strip()
    if len(url) > 500:
        raise InvalidMeetingLink("الرابط طويل جدًا.")
    try:
        p = urlsplit(url)
        host = (p.hostname or "").lower()
    except ValueError:
        raise InvalidMeetingLink("الرابط غير صالح.") from None
    if p.scheme != "https" or not host:
        raise InvalidMeetingLink("استخدم رابطًا يبدأ بـ https://")
    if p.username or p.password or p.port not in (None, 443):
        raise InvalidMeetingLink("الرابط غير صالح.")
    provider = next((k for k, hosts in PROVIDERS.items() if any(host == h or host.endswith("." + h) for h in hosts)), None)
    if provider is None:
        raise InvalidMeetingLink("الروابط المقبولة: Google Meet أو Zoom أو Jitsi أو Microsoft Teams.")
    keys = {k.lower() for k in parse_qs(p.query, keep_blank_values=True)}
    if keys & HOST_SECRETS or (provider == "zoom" and p.path.startswith("/s/")):
        raise InvalidMeetingLink("هذا رابط المضيف. انسخ رابط الدعوة للمشاركين.")
    if provider == "google_meet" and len(p.path.strip("/")) < 3:
        raise InvalidMeetingLink("انسخ رابط الاجتماع نفسه، لا الصفحة الرئيسية.")
    return provider
