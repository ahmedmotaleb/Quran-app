"""Meeting providers for live sessions (pack prompt 19). The first adapter is "a meeting link the teacher pastes":
no custom video, no provider credentials on our server. Only https links on known meeting hosts are accepted, and
links that carry a host credential (a Zoom start link, a sign-in token, user:password@) are refused, so a student
can never receive the teacher's host access. Adding Zoom/Meet APIs later means a new adapter, not new fields."""
import re
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


_INVISIBLE = re.compile(r"[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u00a0]")
_SCHEME = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.-]*):")


def normalize(url: str) -> str:
    """What a teacher pasted → the link to store (owner request, 14 Nov 2026).
    - Surrounding spaces, invisible characters (from chat apps) and wrapping quotes or <> are removed.
    - No protocol («meet.google.com/abc-defg-hij») → «https://» is added, once.
    - «http://» becomes «https://» (all supported meeting services serve https).
    The host, path, meeting ID and query are kept exactly. Any other scheme (javascript:, data:, mailto:, intent:…)
    raises InvalidMeetingLink. The result still goes through provider_for (known meeting hosts only, no host links)."""
    u = _INVISIBLE.sub("", url or "").strip().strip("\"'<>«»").strip()
    if not u:
        return ""
    if u.startswith("//"):
        u = "https:" + u
    m = _SCHEME.match(u)
    if m and u[m.end():m.end() + 2] == "//":
        scheme = m.group(1).lower()
        if scheme == "http":
            u = "https" + u[m.end() - 1:]
        elif scheme == "https":
            u = "https" + u[m.end() - 1:]          # «HTTPS://…» → «https://…»
        else:
            raise InvalidMeetingLink("الرابط غير صالح.")
    elif m and "." not in m.group(1):              # javascript:, data:, mailto:… (a host never comes before «:» without a dot)
        raise InvalidMeetingLink("الرابط غير صالح.")
    else:
        u = "https://" + u
    return u


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
