"""push_report (Ops task push-report): read-only; detects a VAPID key pair that does not match; no endpoints or keys."""
import base64
import json
from io import StringIO

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from django.core.management import call_command

from apps.notifications.models import PushSubscription

pytestmark = pytest.mark.django_db
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()  # noqa: E731


def pair():
    k = ec.generate_private_key(ec.SECP256R1())
    return (b64(k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)),
            b64(k.private_numbers().private_value.to_bytes(32, "big")))


def report(settings, pub, priv):
    settings.VAPID_PUBLIC_KEY, settings.VAPID_PRIVATE_KEY = pub, priv
    out = StringIO()
    call_command("push_report", stdout=out)
    return out.getvalue(), json.loads(out.getvalue())


def test_report_checks_keys_and_counts_devices(world, settings):
    pub, priv = pair()
    PushSubscription.objects.create(user=world.s1, endpoint="https://fcm.googleapis.com/fcm/send/secret-endpoint-1", p256dh="P" * 80,
                                    auth="A" * 20, device="Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile")
    raw, r = report(settings, pub, priv)
    assert r["config"]["keys_match"] is True and r["config"]["private_key_valid"] is True
    assert r["devices"]["total"] == 1 and r["devices"]["by_family"] == {"android": 1} and r["devices"]["by_role"] == {"student": 1}
    assert "secret-endpoint" not in raw and "P" * 80 not in raw and priv not in raw
    assert report(settings, pair()[0], priv)[1]["config"]["keys_match"] is False      # mismatched pair
    assert report(settings, "", "")[1]["config"]["keys_match"] is False


def test_report_shows_admin_tests_and_switched_off_devices(world, settings):
    from apps.core.audit import audit

    PushSubscription.objects.create(user=world.s1, endpoint="https://fcm.googleapis.com/fcm/send/x", p256dh="P" * 80, auth="A" * 20,
                                    device="Android", active=False, last_failure="unauthorized")
    audit("admin.push_test", target=world.s1, devices=1, sent=0, failed=["unauthorized"])
    r = report(settings, *pair())[1]
    assert r["devices"]["inactive"] == 1 and r["devices"]["last_failures"] == {"unauthorized": 1}
    assert r["admin_tests_7d"][0]["target"] == str(world.s1.pk) and r["admin_tests_7d"][0]["sent"] == 0
