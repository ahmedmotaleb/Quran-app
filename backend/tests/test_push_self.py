"""«حسابي ← الإشعارات»: this device's push diagnostics and «إرسال إشعار تجريبي» to the signed-in account's own devices."""
import pytest
from django.core.cache import cache

from apps.notifications.models import PushSubscription

from .conftest import client_for
from .test_push import FakePush, keys  # noqa: F401  (fixture)

pytestmark = pytest.mark.django_db
EP = "https://fcm.googleapis.com/fcm/send/this-phone"


def sub(u, ep=EP, **kw):
    return PushSubscription.objects.create(user=u, endpoint=ep, p256dh="p", auth="a", device="Mozilla/5.0 (Linux; Android 14) Chrome/130", **kw)


def test_status_reports_this_device_without_secrets(world, keys):  # noqa: F811
    c = client_for(world.s1)
    r = c.get("/api/v1/push/status", {"endpoint": EP}).json()
    assert r["server"] == "ready" and r["this_device"] is None and r["devices"] == 0
    assert r["prefs"]["reminders"] is True and r["timezone"] and r["reminders"]["reading"]["hour"] == 20
    sub(world.s1)
    r = c.get("/api/v1/push/status", {"endpoint": EP}).json()
    assert r["this_device"]["active"] is True and r["devices"] == 1
    raw = c.get("/api/v1/push/status", {"endpoint": EP}).content.decode()
    assert "this-phone" not in raw and '"p"' not in raw
    assert client_for(world.t1).get("/api/v1/push/status").json()["reminders"] is None   # teachers: no Quran reminders


def test_self_test_sends_to_this_device_and_is_rate_limited(world, keys, monkeypatch):  # noqa: F811
    fake = FakePush(monkeypatch)
    c = client_for(world.s1)
    r = c.post("/api/v1/push/test", {"endpoint": EP}, format="json").json()
    assert r["devices"] == 0 and "ربط الجهاز" in r["message"]
    cache.clear()
    sub(world.s1)
    r = c.post("/api/v1/push/test", {"endpoint": EP}, format="json").json()
    assert r["this_device"] and r["this_device_sent"] and r["sent"] == 1 and r["message"].startswith("قبلت خدمة الإشعارات")
    assert fake.sent[-1][1]["title"] == "الحلقة" and fake.sent[-1][1]["tag"] == "test"
    assert c.post("/api/v1/push/test", {"endpoint": EP}, format="json").status_code == 429          # once a minute
    cache.delete(f"pushself:m:{world.s1.pk}")
    r = c.post("/api/v1/push/test", {"endpoint": "https://fcm.googleapis.com/fcm/send/other"}, format="json").json()
    assert r["this_device"] is False and "غير مسجّل" in r["message"]
    assert client_for(world.s2).post("/api/v1/push/test", {"endpoint": EP}, format="json").json()["devices"] == 0  # own devices only


def test_self_test_reports_a_refused_device(world, keys, monkeypatch):  # noqa: F811
    FakePush(monkeypatch, fail_status=410)
    sub(world.s1)
    r = client_for(world.s1).post("/api/v1/push/test", {"endpoint": EP}, format="json").json()
    assert r["this_device_sent"] is False and "رفضت" in r["message"]
    assert not PushSubscription.objects.filter(endpoint=EP).exists()      # gone: removed, the app re-connects
