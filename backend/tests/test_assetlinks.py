"""Digital Asset Links for the Android app (Trusted Web Activity)."""
import pytest

FP = ":".join(["AB"] * 32)


@pytest.mark.django_db
def test_assetlinks_lists_only_configured_fingerprints(client, settings):
    settings.ANDROID_CERT_SHA256 = []
    assert client.get("/.well-known/assetlinks.json").status_code == 404           # no app configured: nothing published
    settings.ANDROID_CERT_SHA256 = ["NOT-A-FINGERPRINT"]
    assert client.get("/.well-known/assetlinks.json").status_code == 404
    settings.ANDROID_CERT_SHA256 = [FP]
    r = client.get("/.well-known/assetlinks.json")
    assert r.status_code == 200 and r["Content-Type"] == "application/json"
    body = r.json()
    assert body == [{"relation": ["delegate_permission/common.handle_all_urls"],
                     "target": {"namespace": "android_app", "package_name": "app.halqa.quran", "sha256_cert_fingerprints": [FP]}}]
