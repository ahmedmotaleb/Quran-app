"""Web Push in production (owner request, 26 Oct 2026): real readiness (keys present AND matching), devices per
browser, current-device opt-out and sign-out, dead endpoints removed or switched off, privacy-safe lock-screen text
for every event, and the admin's «إرسال إشعار تجريبي» with safe device diagnostics."""
import json

import pytest
from django.core.cache import cache

from apps.core.models import AuditEvent
from apps.notifications import push
from apps.notifications.models import Notification, PushSubscription
from apps.notifications.services import notify

from .conftest import client_for, occurrence
from .test_admins import staff, with_mfa
from .test_push import FakePush, key_pair

pytestmark = pytest.mark.django_db
ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36"
DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"


def sub(n):
    return {"endpoint": f"https://fcm.googleapis.com/fcm/send/device-{n}", "keys": {"p256dh": f"BKey{n}" * 10, "auth": f"auth{n}"}}


@pytest.fixture
def keys(settings):
    settings.VAPID_PUBLIC_KEY, settings.VAPID_PRIVATE_KEY = key_pair()


def register(user, n, ua=ANDROID):
    return client_for(user).post("/api/v1/push/subscriptions", sub(n), format="json", HTTP_USER_AGENT=ua)


class Recorder(FakePush):
    """Fake push service: per-endpoint failures can be set."""

    def __init__(self, monkeypatch, fail=None):
        import pywebpush

        self.sent, self.fail = [], fail or {}

        def webpush(subscription_info, data, **kw):
            st = self.fail.get(subscription_info["endpoint"])
            if st:
                raise pywebpush.WebPushException("x", response=type("R", (), {"status_code": st})())
            self.sent.append((subscription_info["endpoint"], json.loads(data)))

        monkeypatch.setattr(pywebpush, "webpush", webpush)


# readiness -----------------------------------------------------------------------------------------------------
def test_readiness_needs_matching_keys(world, settings):
    settings.VAPID_PUBLIC_KEY = settings.VAPID_PRIVATE_KEY = ""
    assert client_for(world.s1).get("/api/ready").json()["features"]["push"] == "not_configured"
    pub, _ = key_pair()
    settings.VAPID_PUBLIC_KEY, settings.VAPID_PRIVATE_KEY = pub, key_pair()[1]          # the keys do not belong together
    assert client_for(world.s1).get("/api/ready").json()["features"]["push"] == "misconfigured"
    cfg = client_for(world.s1).get("/api/v1/push/config").json()
    assert cfg["enabled"] is False and cfg["public_key"] is None and cfg["status"] == "misconfigured"
    assert register(world.s1, 1).json()["code"] == "push_not_configured"
    settings.VAPID_PUBLIC_KEY, settings.VAPID_PRIVATE_KEY = key_pair()
    assert client_for(world.s1).get("/api/ready").json()["features"]["push"] == "ready"
    cfg = client_for(world.s1).get("/api/v1/push/config").json()
    assert cfg["enabled"] is True and cfg["public_key"] == settings.VAPID_PUBLIC_KEY and "private" not in json.dumps(cfg).lower()


# devices -------------------------------------------------------------------------------------------------------
def test_duplicate_and_multiple_devices(world, keys, monkeypatch):
    fake = Recorder(monkeypatch)
    assert register(world.s1, 1).status_code == 201
    assert register(world.s1, 1).status_code == 201                      # the same browser again: still one device
    assert register(world.s1, 2, DESKTOP).status_code == 201             # Android PWA + desktop Chrome
    assert PushSubscription.objects.filter(user=world.s1).count() == 2
    notify(world.s1, "assignment_new", "x", dedupe="a1")
    assert {ep for ep, _ in fake.sent} == {sub(1)["endpoint"], sub(2)["endpoint"]}
    # a shared browser: the endpoint moves to the account now signed in
    register(world.s2, 2, DESKTOP)
    assert PushSubscription.objects.get(endpoint=sub(2)["endpoint"]).user == world.s2


def test_sign_out_and_opt_out_only_this_device(world, keys, monkeypatch):
    fake = Recorder(monkeypatch)
    register(world.s1, 1)
    register(world.s1, 2, DESKTOP)
    r = client_for(world.s1).post("/api/v1/auth/logout", {"push_endpoint": sub(1)["endpoint"]}, format="json")
    assert r.status_code == 204
    assert list(PushSubscription.objects.filter(user=world.s1).values_list("endpoint", flat=True)) == [sub(2)["endpoint"]]
    notify(world.s1, "booking_confirmed", "x", dedupe="b1")
    assert [ep for ep, _ in fake.sent] == [sub(2)["endpoint"]]           # the desktop still receives
    assert client_for(world.s1).delete("/api/v1/push/subscriptions", {"endpoint": sub(2)["endpoint"]}, format="json").json() == {"removed": 1}
    assert not PushSubscription.objects.filter(user=world.s1).exists()


def test_device_state_reported_per_endpoint(world, keys):
    register(world.s1, 1)
    c = client_for(world.s1)
    assert c.get("/api/v1/push/config", {"endpoint": sub(1)["endpoint"]}).json()["this_device"] is True
    assert c.get("/api/v1/push/config", {"endpoint": sub(9)["endpoint"]}).json()["this_device"] is False
    assert client_for(world.s2).get("/api/v1/push/config", {"endpoint": sub(1)["endpoint"]}).json()["this_device"] is False


def test_preferences_filter_categories_but_not_account_alerts(world, keys, monkeypatch):
    fake = Recorder(monkeypatch)
    register(world.s1, 1)
    world.s1.notify_prefs = {"tasks": False}
    world.s1.save()
    notify(world.s1, "assignment_new", "x", dedupe="p1")
    assert fake.sent == [] and Notification.objects.filter(recipient=world.s1, kind="assignment_new").exists()   # inbox still
    notify(world.s1, "absence_warning", "x", dedupe="p2")
    assert len(fake.sent) == 1


# failures --------------------------------------------------------------------------------------------------------
def test_dead_and_failing_endpoints(world, keys, monkeypatch):
    fake = Recorder(monkeypatch)
    for n in (1, 2, 3):
        register(world.s1, n)
    fake.fail = {sub(1)["endpoint"]: 410, sub(2)["endpoint"]: 403, sub(3)["endpoint"]: 503}
    notify(world.s1, "assignment_new", "x", dedupe="f1")
    assert not PushSubscription.objects.filter(endpoint=sub(1)["endpoint"]).exists()           # gone: removed
    s2 = PushSubscription.objects.get(endpoint=sub(2)["endpoint"])
    assert s2.active is False and s2.last_failure == "unauthorized"                             # other keys: off at once
    s3 = PushSubscription.objects.get(endpoint=sub(3)["endpoint"])
    assert s3.active is True and s3.last_failure == "push_service" and s3.failures == 1
    for i in range(push.MAX_FAILURES - 1):
        notify(world.s1, "assignment_new", "x", dedupe=f"f{i + 2}")
    s3.refresh_from_db()
    assert s3.active is False and s3.failures == push.MAX_FAILURES                              # no endless retries
    fake.fail = {}
    notify(world.s1, "assignment_new", "x", dedupe="f9")
    assert fake.sent == []                                                                      # inactive devices are skipped
    register(world.s1, 3)                                                                       # the app re-registers it
    s3.refresh_from_db()
    assert s3.active is True and s3.failures == 0 and s3.last_failure == ""
    notify(world.s1, "assignment_new", "x", dedupe="f10")
    assert [ep for ep, _ in fake.sent] == [sub(3)["endpoint"]]


# privacy ---------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("kind,link", [
    ("assignment_new", "/tasks/7"), ("feedback_new", "/tasks/7"), ("booking_confirmed", "/sessions/3"), ("booking_cancelled", "/sessions"),
    ("booking_rescheduled", "/sessions"), ("session_reminder", "/sessions"), ("review_due", "/today"), ("attendance_absent", "/sessions"),
    ("lesson_published", ""), ("quiz_published", ""), ("support_reply", "/support/4"),
])
def test_lock_screen_text_is_generic_for_every_event(world, keys, monkeypatch, kind, link):
    fake = Recorder(monkeypatch)
    register(world.s1, 1)
    secret = "خطأ في سورة الملك آية 5 — الدرجة 3/5 — ملاحظة خاصة https://r2.example/rec.webm"
    notify(world.s1, kind, f"عنوان {secret}", secret, link=link, dedupe=f"priv-{kind}")
    [(_, payload)] = fake.sent
    text = json.dumps(payload, ensure_ascii=False)
    n = Notification.objects.get(recipient=world.s1, kind=kind)
    assert payload["title"] == "الحلقة" and payload["url"] == f"/#/n/{n.pk}"          # the app opens it after sign-in
    assert set(payload) == {"title", "body", "url", "tag"}
    for leak in ("الملك", "الدرجة", "ملاحظة", "r2.example", world.s1.full_name):
        assert leak not in text


# admin -----------------------------------------------------------------------------------------------------------
def test_admin_test_notification(world, keys, monkeypatch):
    cache.clear()
    fake = Recorder(monkeypatch)
    owner = with_mfa(world.admin)
    c = client_for(owner)
    r = c.post(f"/api/v1/admin/users/{world.s1.pk}/push-test", {"title": "x", "body": "anything"}, format="json")
    assert r.status_code == 200 and r.json()["message"] == "لا توجد أجهزة مفعّل عليها الإشعارات لهذا المستخدم."
    cache.clear()
    register(world.s1, 1)
    register(world.s1, 2, DESKTOP)
    PushSubscription.objects.filter(endpoint=sub(2)["endpoint"]).update(active=False)
    r = c.post(f"/api/v1/admin/users/{world.s1.pk}/push-test", {"title": "مخصص", "body": "نص مخصص"}, format="json")
    assert r.status_code == 200 and r.json()["sent"] == 1 and r.json()["message"] == "تم إرسال الإشعار إلى جهاز واحد."
    [(ep, payload)] = fake.sent
    assert ep == sub(1)["endpoint"] and payload == push.TEST                      # fixed text; no arbitrary payload
    assert payload["body"] == "هذا إشعار تجريبي للتأكد من عمل الإشعارات."
    ev = AuditEvent.objects.filter(action="admin.push_test").latest("id")
    assert ev.data["sent"] == 1 and "endpoint" not in json.dumps(ev.data)
    assert c.post(f"/api/v1/admin/users/{world.s1.pk}/push-test", format="json").status_code == 429       # per person
    monkeypatch.setattr("apps.notifications.views.TEST_PER_ADMIN", (1, 3600))
    cache.clear()
    assert c.post(f"/api/v1/admin/users/{world.s2.pk}/push-test", format="json").status_code == 200
    assert c.post(f"/api/v1/admin/users/{world.t1.pk}/push-test", format="json").status_code == 429       # per admin


def test_admin_test_needs_permission_and_ready_server(world, keys, settings):
    cache.clear()
    content = staff("content@x.test", preset="content")
    assert client_for(content).post(f"/api/v1/admin/users/{world.s1.pk}/push-test", format="json").status_code == 403
    assert client_for(world.t1).post(f"/api/v1/admin/users/{world.s1.pk}/push-test", format="json").status_code == 403
    assert client_for(world.s2).get(f"/api/v1/admin/users/{world.s1.pk}/push-devices").status_code == 403
    settings.VAPID_PRIVATE_KEY = ""
    r = client_for(world.admin).post(f"/api/v1/admin/users/{world.s1.pk}/push-test", format="json")
    assert r.status_code == 503 and r.json()["code"] == "push_not_configured"


def test_admin_device_diagnostics_are_safe(world, keys, monkeypatch):
    Recorder(monkeypatch, fail={sub(2)["endpoint"]: 429})
    register(world.s1, 1)
    register(world.s1, 2, DESKTOP)
    notify(world.s1, "assignment_new", "x", dedupe="d1")
    r = client_for(world.admin).get(f"/api/v1/admin/users/{world.s1.pk}/push-devices").json()
    assert r["status"] == "ready"
    by = {d["family"]: d for d in r["results"]}
    assert by["android"]["active"] and by["android"]["last_success_at"]
    assert by["desktop-chrome"]["last_failure"] == "rate_limited"
    raw = json.dumps(r)
    for secret in ("fcm.googleapis.com", "BKey", "auth1", "Mozilla"):
        assert secret not in raw


def test_booking_event_reaches_inbox_and_phone(world, keys, monkeypatch, django_capture_on_commit_callbacks):
    from apps.scheduling import services

    fake = Recorder(monkeypatch)
    register(world.s1, 1)
    o = occurrence(world.t1, in_hours=48)
    with django_capture_on_commit_callbacks(execute=True):
        services.book(student=world.s1, occurrence_id=o.pk, idempotency_key="e2e-push")
    assert Notification.objects.filter(recipient=world.s1, kind="booking_confirmed").exists()
    assert [p["body"] for _, p in fake.sent] == ["تحديث على أحد مواعيدك."]


def test_tapped_notification_is_only_readable_by_its_owner(world):
    n = notify(world.s1, "feedback_new", "تقييم", "تفاصيل", link="/tasks/7", dedupe="own", data={"assignment": 7})
    assert client_for(world.s1).get(f"/api/v1/notifications/{n.pk}").json()["data"] == {"assignment": 7}
    assert client_for(world.s2).get(f"/api/v1/notifications/{n.pk}").status_code == 404
    from rest_framework.test import APIClient

    assert APIClient().get(f"/api/v1/notifications/{n.pk}").status_code in (401, 403)
