"""Recording diagnostics from real phones: a short, checked note goes to the server log only."""
import logging

import pytest

from apps.core.diagnostics import device

from .conftest import client_for

pytestmark = pytest.mark.django_db
URL = "/api/v1/client-diagnostics"
IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"


def test_failure_is_logged_with_checked_fields_only(world, caplog):
    c = client_for(world.s1)
    with caplog.at_level(logging.INFO, logger="halqa.client"):
        r = c.post(URL, {"event": "mic_denied", "step": "start", "error": "NotAllowedError: Permission denied <script>x@y.com",
                         "supported": ["audio/mp4", "audio/webm;codecs=opus", {"x": 1}], "standalone": True, "online": True,
                         "secs": "12.34", "size_kb": "abc", "audio": "AAAA", "note": "اسم الطالب"},
                   format="json", HTTP_USER_AGENT=IPHONE)
    assert r.status_code == 204
    rec = next(x for x in caplog.records if x.getMessage() == "client_diagnostic")
    assert rec.levelname == "WARNING" and rec.event == "mic_denied" and rec.device == "Safari iPhone 17.4"
    assert "<" not in rec.error and "@" not in rec.error and rec.secs == 12.3 and rec.size_kb is None
    assert rec.err_code == ""
    assert rec.standalone is True and rec.user == world.s1.pk and rec.role == "student"
    assert not hasattr(rec, "audio") and not hasattr(rec, "note")  # unknown fields are never logged


def test_success_is_info_and_bad_input_refused(world, caplog):
    c = client_for(world.s1)
    with caplog.at_level(logging.INFO, logger="halqa.client"):
        assert c.post(URL, {"event": "submit_ok", "secs": 31}, format="json").status_code == 204
        c.post(URL, {"event": "upload_failed", "code": "storage_unavailable", "error": "Error: تعذّر حفظ التسجيل الآن"}, format="json")
    assert any(x.levelname == "INFO" and x.event == "submit_ok" for x in caplog.records)
    up = next(x for x in caplog.records if getattr(x, "event", "") == "upload_failed")
    assert up.err_code == "storage_unavailable" and "تعذّر حفظ التسجيل" in up.error
    assert c.post(URL, {"event": "anything"}, format="json").status_code == 400
    from rest_framework.test import APIClient

    assert APIClient().post(URL, {"event": "submit_ok"}, format="json").status_code in (401, 403)


def test_device_family():
    assert device(IPHONE) == "Safari iPhone 17.4"
    assert device("Mozilla/5.0 (Linux; Android 14; SM-A146P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0 Mobile Safari/537.36") == "Chrome Android 14"
    assert device("") == "other other"
