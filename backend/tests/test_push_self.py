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


def test_delivery_receipt_from_the_phone(world, keys, monkeypatch):  # noqa: F811
    """The service worker reports that the push arrived and was displayed (or refused), with the signed token from the
    payload; no session; a forged token changes nothing."""
    from rest_framework.test import APIClient

    fake = FakePush(monkeypatch)
    s = sub(world.s1)
    client_for(world.s1).post("/api/v1/push/test", {"endpoint": EP}, format="json")
    token = fake.sent[-1][1]["r"]
    anon = APIClient()
    assert anon.post("/api/v1/push/receipt", {"r": "forged", "ok": True}, format="json").status_code == 204
    s.refresh_from_db()
    assert s.last_receipt_at is None
    assert anon.post("/api/v1/push/receipt", {"r": token, "ok": True, "shown": True}, format="json").status_code == 204
    s.refresh_from_db()
    assert s.last_receipt == "shown" and s.last_receipt_at is not None
    st = client_for(world.s1).get("/api/v1/push/status", {"endpoint": EP}).json()["this_device"]
    assert st["last_receipt"] == "shown" and st["last_receipt_at"]
    anon.post("/api/v1/push/receipt", {"r": token, "ok": False, "error": "TypeError<script>"}, format="json")
    s.refresh_from_db()
    assert s.last_receipt == "error:TypeErrorscript"
    # another account's device is never touched by this token
    other = sub(world.s2, ep="https://fcm.googleapis.com/fcm/send/other-phone")
    other.refresh_from_db()
    assert other.last_receipt_at is None


# ---- persistent registration (owner report 13 Nov 2026: the app asked again after every reopen / sign-in) ---------
def test_browser_renewed_subscription_moves_the_device_without_a_session(world, keys, monkeypatch):  # noqa: F811
    """pushsubscriptionchange: the service worker proves it held the old subscription (endpoint + keys) and the
    server moves that device to the new one, same account. Mismatches change nothing; nothing is created."""
    from rest_framework.test import APIClient

    s = sub(world.s1)
    anon = APIClient()
    new = {"endpoint": "https://fcm.googleapis.com/fcm/send/renewed", "keys": {"p256dh": "P2", "auth": "A2"}}
    # wrong keys for the old endpoint: refused silently
    assert anon.post("/api/v1/push/rotate", {"old": {"endpoint": EP, "keys": {"p256dh": "x", "auth": "a"}}, "new": new}, format="json").status_code == 204
    assert PushSubscription.objects.get(pk=s.pk).endpoint == EP
    # unknown old endpoint: nothing created
    anon.post("/api/v1/push/rotate", {"old": {"endpoint": "https://fcm.googleapis.com/fcm/send/nope", "keys": {"p256dh": "p", "auth": "a"}}, "new": new}, format="json")
    assert PushSubscription.objects.count() == 1
    # the real old subscription: moved, same account, switched (back) on
    PushSubscription.objects.filter(pk=s.pk).update(active=False, failures=3, last_failure="network")
    anon.post("/api/v1/push/rotate", {"old": {"endpoint": EP, "keys": {"p256dh": "p", "auth": "a"}}, "new": new}, format="json")
    s.refresh_from_db()
    assert (s.endpoint, s.p256dh, s.auth, s.user_id, s.active, s.failures) == (new["endpoint"], "P2", "A2", world.s1.pk, True, 0)
    assert PushSubscription.objects.count() == 1


def test_one_phone_shared_by_two_accounts_gets_only_the_signed_in_accounts_notices(world, keys, monkeypatch):  # noqa: F811
    """Signing in with another account on the same phone moves this device to that account (the endpoint is unique);
    the previous account's notices no longer reach it. Signing out removes the device from the server only."""
    fake = FakePush(monkeypatch)
    body = {"endpoint": EP, "keys": {"p256dh": "p" * 20, "auth": "a" * 10}}
    assert client_for(world.s1).post("/api/v1/push/subscriptions", body, format="json").status_code == 201
    assert client_for(world.t1).post("/api/v1/push/subscriptions", body, format="json").status_code == 201   # same phone, other account
    assert PushSubscription.objects.count() == 1 and PushSubscription.objects.get().user_id == world.t1.pk
    from apps.notifications.services import notify

    with django_commit():
        notify(world.s1, "assignment_new", "x", dedupe="shared-1")
        notify(world.t1, "submission_new", "x", dedupe="shared-2")
    assert [p["tag"] for _, p in fake.sent] == ["submission"]          # only the signed-in account's notice
    # signing out keeps nothing for that account on the server; signing in again (permission still granted) re-registers
    assert client_for(world.t1).post("/api/v1/auth/logout", {"push_endpoint": EP}, format="json").status_code == 204
    assert not PushSubscription.objects.exists()
    assert client_for(world.t1).post("/api/v1/push/subscriptions", body, format="json").status_code == 201
    assert PushSubscription.objects.get().user_id == world.t1.pk


def test_start_up_restore_outcome_is_logged_without_personal_data(world, caplog):
    c = client_for(world.s1)
    with caplog.at_level("INFO", logger="halqa.client"):
        r = c.post("/api/v1/client-diagnostics", {"event": "push_restore", "step": "on", "code": "granted"}, format="json")
    assert r.status_code == 204
    rec = [x for x in caplog.records if getattr(x, "event", "") == "push_restore"]
    assert rec and rec[-1].step == "on" and rec[-1].levelname == "INFO"


class django_commit:
    """Run on_commit callbacks at the end of the block (the test transaction never commits)."""

    def __enter__(self):
        from django.db import transaction

        self._cb = []
        self._orig = transaction.on_commit
        transaction.on_commit = lambda fn, using=None, robust=False: self._cb.append(fn)
        return self

    def __exit__(self, *exc):
        from django.db import transaction

        transaction.on_commit = self._orig
        while self._cb:
            self._cb.pop(0)()
