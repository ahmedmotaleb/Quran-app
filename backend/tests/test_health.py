import pytest


@pytest.mark.django_db
def test_health_and_ready(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    assert "X-Request-ID" in r
    r = client.get("/api/ready")
    assert r.status_code == 200
    assert r.json()["checks"] == {"database": "ok", "migrations": "ok"}


@pytest.mark.django_db
def test_errors_are_arabic_with_request_id(client):
    r = client.get("/api/v1/me", HTTP_X_REQUEST_ID="test-req-12345")
    assert r.status_code in (401, 403)
    body = r.json()
    assert body["code"] == "not_authenticated" and "تسجيل الدخول" in body["message"]
    assert body["request_id"] == "test-req-12345" and r["X-Request-ID"] == "test-req-12345"
