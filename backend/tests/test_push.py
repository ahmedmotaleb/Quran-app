"""Pack prompt 18 (Web Push): off without keys; opt-in/out per device; generic lock-screen text; gone endpoints removed."""
import json

import pytest

from apps.notifications.models import Notification, PushSubscription
from apps.notifications.services import notify

from .conftest import client_for

pytestmark = pytest.mark.django_db
SUB = {"endpoint": "https://push.example.test/abc", "keys": {"p256dh": "BPk3", "auth": "a1"}}


def key_pair():
    """A real P-256 pair (generated per test run, never stored): readiness checks that the keys belong together."""
    import base64

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    k = ec.generate_private_key(ec.SECP256R1())
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()  # noqa: E731
    return (b64(k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)),
            b64(k.private_numbers().private_value.to_bytes(32, "big")))


@pytest.fixture
def keys(settings):
    settings.VAPID_PUBLIC_KEY, settings.VAPID_PRIVATE_KEY = key_pair()


class FakePush:
    def __init__(self, monkeypatch, fail_status=None):
        self.sent = []
        import pywebpush

        def webpush(subscription_info, data, **kw):
            if fail_status:
                raise pywebpush.WebPushException("gone", response=type("R", (), {"status_code": fail_status})())
            self.sent.append((subscription_info["endpoint"], json.loads(data)))

        monkeypatch.setattr(pywebpush, "webpush", webpush)


def test_push_is_off_without_keys(world, settings):
    settings.VAPID_PUBLIC_KEY = settings.VAPID_PRIVATE_KEY = ""
    c = client_for(world.s1)
    assert c.get("/api/v1/push/config").json() == {"enabled": False, "status": "not_configured", "public_key": None, "this_device": False,
                                                   "this_device_inactive": False, "devices": 0}
    r = c.post("/api/v1/push/subscriptions", SUB, format="json")
    assert r.status_code == 503 and r.json()["code"] == "push_not_configured"
    assert client_for(world.admin).get("/api/ready").json()["features"]["push"] == "not_configured"


def test_subscribe_receive_generic_text_and_opt_out(world, keys, monkeypatch):
    fake = FakePush(monkeypatch)
    c = client_for(world.s1)
    assert c.post("/api/v1/push/subscriptions", SUB, format="json").status_code == 201
    assert c.get("/api/v1/push/config", {"endpoint": SUB["endpoint"]}).json()["this_device"] is True
    notify(world.s1, "feedback_new", "تقييم جديد من الشيخ فلان", "سورة الملك 1–10: 4 من 5", link="/tasks/7", dedupe="t1")
    [(ep, payload)] = fake.sent
    n = Notification.objects.get(recipient=world.s1, kind="feedback_new")
    assert ep == SUB["endpoint"] and payload["body"] == "وصل تقييم جديد من معلمك." and payload["url"] == f"/#/n/{n.pk}"
    assert "الملك" not in json.dumps(payload, ensure_ascii=False) and "فلان" not in json.dumps(payload, ensure_ascii=False)
    notify(world.s2, "feedback_new", "x", dedupe="t2")  # other users' devices are not touched
    assert len(fake.sent) == 1
    assert c.delete("/api/v1/push/subscriptions", {"endpoint": SUB["endpoint"]}, format="json").json() == {"removed": 1}
    notify(world.s1, "assignment_new", "x", dedupe="t3")
    assert len(fake.sent) == 1  # opted out


@pytest.mark.parametrize("status,kept", [(410, False), (404, False), (500, True)])
def test_gone_endpoints_are_removed_others_kept(world, keys, monkeypatch, status, kept):
    FakePush(monkeypatch, fail_status=status)
    client_for(world.s1).post("/api/v1/push/subscriptions", SUB, format="json")
    assert notify(world.s1, "review_due", "x", dedupe="r") is not None  # the in-app notification is unaffected
    assert PushSubscription.objects.filter(endpoint=SUB["endpoint"]).exists() is kept


def test_invalid_subscriptions_refused_and_shared_device_moves(world, keys):
    c = client_for(world.s1)
    for bad in ({"endpoint": "http://insecure/x", "keys": SUB["keys"]}, {"endpoint": SUB["endpoint"], "keys": {}}, {}):
        assert c.post("/api/v1/push/subscriptions", bad, format="json").status_code == 400
    c.post("/api/v1/push/subscriptions", SUB, format="json")
    client_for(world.s2).post("/api/v1/push/subscriptions", SUB, format="json")  # same browser, another account signs in
    assert PushSubscription.objects.get(endpoint=SUB["endpoint"]).user_id == world.s2.id
    assert client_for(world.s1).delete("/api/v1/push/subscriptions", SUB, format="json").json() == {"removed": 0}


def test_preferences_mute_a_category_but_never_account_notices(world, keys, monkeypatch):
    fake = FakePush(monkeypatch)
    c = client_for(world.s1)
    c.post("/api/v1/push/subscriptions", SUB, format="json")
    r = c.patch("/api/v1/me", {"notify_prefs": {"tasks": False}}, format="json")
    assert r.status_code == 200 and r.json()["notify_prefs"] == {"tasks": False}
    assert c.patch("/api/v1/me", {"notify_prefs": {"tasks": "no"}}, format="json").status_code == 400
    assert c.patch("/api/v1/me", {"notify_prefs": {"grades": False}}, format="json").status_code == 400
    c.patch("/api/v1/me", {"notify_prefs": {"news": False}}, format="json")  # merged, tasks stays off
    world.s1.refresh_from_db()
    assert world.s1.notify_prefs == {"tasks": False, "news": False}
    from apps.notifications.models import Notification

    notify(world.s1, "assignment_new", "x", dedupe="p1")  # muted: kept in the app, not pushed
    assert fake.sent == [] and Notification.objects.filter(recipient=world.s1, kind="assignment_new").exists()
    notify(world.s1, "session_reminder", "x", dedupe="p2")
    notify(world.s1, "absence_warning", "x", dedupe="p3")  # account notice: always pushed
    assert [p["body"] for _, p in fake.sent] == ["تذكير بجلسة قادمة.", "تنبيه بشأن الحضور."]


def test_every_kind_in_use_has_generic_text_and_no_private_details(world, keys, monkeypatch):
    import re
    from pathlib import Path

    from apps.notifications.push import FALLBACK, payload_for

    root = Path(__file__).resolve().parents[1] / "apps"
    kinds = set()
    for f in root.rglob("*.py"):
        kinds |= set(re.findall(r'(?:notify|after_commit)\([\w.]+,\s*"([a-z_]+)"', f.read_text(encoding="utf-8")))
    assert {"waitlist_offer", "makeup_granted", "excuse_approved", "weekly_report"} <= kinds
    for k in kinds:
        p = payload_for(k, "/x")
        assert set(p) == {"title", "body", "url", "tag"}, k
        assert p["body"] != FALLBACK[1], f"{k} has no specific generic text"


def test_logout_removes_this_devices_subscription(world, keys):
    c = client_for(world.s1)
    c.post("/api/v1/push/subscriptions", SUB, format="json")
    other = {**SUB, "endpoint": "https://push.example.test/other"}
    c.post("/api/v1/push/subscriptions", other, format="json")
    assert c.post("/api/v1/auth/logout", {"push_endpoint": SUB["endpoint"]}, format="json").status_code == 204
    assert list(PushSubscription.objects.values_list("endpoint", flat=True)) == [other["endpoint"]]
