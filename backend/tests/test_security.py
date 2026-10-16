"""Pack prompt 24: security regressions — headers, admin two-step verification, login lockout, cross-role access."""
import pytest
from django.utils import timezone

from apps.accounts import totp
from apps.assessments.models import Answer
from apps.learning.models import ReviewSchedule
from apps.scheduling.models import Booking

from .conftest import PW, client_for, make_user, occurrence
from .test_lessons_quizzes import qids, quiz, rec_upload  # noqa: F401 (fixture)
from .test_media_submissions import FB, _private_root, assignment, submit, upload  # noqa: F401 (fixture)

pytestmark = pytest.mark.django_db


def test_security_headers_on_api_and_health(client):
    for path in ("/api/health", "/api/v1/settings/public"):
        r = client.get(path)
        csp = r["Content-Security-Policy"]
        assert "default-src 'self'" in csp and "script-src 'self'" in csp and "frame-ancestors 'none'" in csp
        assert "unsafe-eval" not in csp and "'unsafe-inline'" not in csp.split("script-src")[1].split(";")[0]
        assert "microphone=(self)" in r["Permissions-Policy"] and "camera=()" in r["Permissions-Policy"]
        assert r["X-Frame-Options"] == "DENY" and r["X-Content-Type-Options"] == "nosniff"


# ---- admin two-step verification ------------------------------------------------------
def test_admin_must_enable_mfa_before_using_admin_apis(world, settings):
    settings.ADMIN_REQUIRE_MFA = True
    c = client_for(world.admin)
    r = c.get("/api/v1/admin/users")
    assert r.status_code == 403 and r.json()["code"] == "mfa_setup_required"
    me = c.get("/api/v1/me").json()
    assert me["mfa_required"] is True and me["mfa_enabled"] is False
    secret = c.post("/api/v1/admin/mfa/setup").json()["secret"]  # still reachable
    assert c.post("/api/v1/admin/mfa/confirm", {"otp": totp._code(secret, int(__import__("time").time()) // 30)}, format="json").json() == {"mfa_enabled": True}
    assert c.get("/api/v1/admin/users").status_code == 200
    # Learning users never see the flag set.
    assert client_for(world.t1).get("/api/v1/me").json()["mfa_required"] is False


def test_mfa_requirement_can_be_off_in_development(world, settings):
    settings.ADMIN_REQUIRE_MFA = False
    assert client_for(world.admin).get("/api/v1/admin/users").status_code == 200


# ---- lockout and throttles ------------------------------------------------------------
def test_account_locks_after_repeated_failures_from_any_ip(world, settings, client):
    settings.LOGIN_LOCKOUT_FAILURES = 3
    settings.REST_FRAMEWORK = {**settings.REST_FRAMEWORK, "DEFAULT_THROTTLE_RATES": {**settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"], "auth": "1000/min"}}
    for i in range(3):
        r = client.post("/api/v1/auth/login", {"email": "S1@x.test", "password": "wrong"}, format="json", REMOTE_ADDR=f"10.0.0.{i}")
        assert r.status_code == 400
    r = client.post("/api/v1/auth/login", {"email": "s1@x.test", "password": PW}, format="json", REMOTE_ADDR="10.9.9.9")
    assert r.status_code == 429 and r.json()["code"] == "account_locked"  # even the right password waits
    # Another account is unaffected, and the lock is recorded without the address.
    assert client.post("/api/v1/auth/login", {"email": "s2@x.test", "password": PW}, format="json").status_code == 200
    from apps.core.models import AuditEvent

    ev = AuditEvent.objects.get(action="auth.locked")
    assert "s1@" not in str(ev.data)


def test_successful_login_resets_the_counter(world, settings, client):
    settings.LOGIN_LOCKOUT_FAILURES = 3
    bad = {"email": "s1@x.test", "password": "wrong"}
    for _ in range(2):
        client.post("/api/v1/auth/login", bad, format="json")
    assert client.post("/api/v1/auth/login", {"email": "s1@x.test", "password": PW}, format="json").status_code == 200
    for _ in range(2):
        client.post("/api/v1/auth/login", bad, format="json")
    assert client.post("/api/v1/auth/login", {"email": "s1@x.test", "password": PW}, format="json").status_code == 200


def test_password_change_is_rate_limited(world):
    c = client_for(world.s1)
    codes = [c.post("/api/v1/auth/password/change", {"current_password": "guess", "new_password": "x"}, format="json").status_code
             for _ in range(12)]
    assert codes[0] == 400 and codes[-1] == 429


# ---- cross-role object access sweep ----------------------------------------------------
def test_no_role_can_reach_another_learners_objects(world, quiz):  # noqa: F811
    """Every id-bearing endpoint, called by people with no relationship to s1's data, answers 403/404 — never data."""
    s1 = client_for(world.s1)
    task = assignment(world)
    media = upload(s1).json()["id"]
    sub = submit(s1, task, media).json()["id"]
    loose = upload(s1).json()["id"]  # not submitted
    booking = Booking.objects.create(occurrence=occurrence(world.t1, in_hours=-1), student=world.s1, idempotency_key="sec")
    attempt = s1.post(f"/api/v1/tests/{quiz.id}/attempts").json()["id"]
    q = qids(quiz)
    s1.post(f"/api/v1/attempts/{attempt}/submit", {"answers": [{"question": q["recitation"], "recording": rec_upload(s1)}]}, format="json")
    answer = Answer.objects.get(attempt_id=attempt, question_id=q["recitation"]).pk
    sch = ReviewSchedule.objects.create(student=world.s1, teacher=world.t1, source=task, surah=67, ayah_from=1, ayah_to=10,
                                        next_due=timezone.localdate())
    sid = world.s1.id
    calls = [
        ("get", f"/api/v1/assignments/{task.pk}"), ("post", f"/api/v1/assignments/{task.pk}/start"),
        ("post", f"/api/v1/assignments/{task.pk}/submissions"), ("get", f"/api/v1/submissions/{sub}"),
        ("post", f"/api/v1/submissions/{sub}/feedback"), ("get", f"/api/v1/media/{media}"), ("get", f"/api/v1/media/{media}/content"),
        ("get", f"/api/v1/media/{loose}"), ("get", f"/api/v1/bookings/{booking.pk}"), ("post", f"/api/v1/bookings/{booking.pk}/cancel"),
        ("post", f"/api/v1/bookings/{booking.pk}/reschedule"), ("post", f"/api/v1/bookings/{booking.pk}/attendance"),
        ("get", f"/api/v1/attempts/{attempt}"), ("post", f"/api/v1/attempts/{attempt}/submit"), ("post", f"/api/v1/answers/{answer}/grade"),
        ("get", f"/api/v1/teacher/students/{sid}/progress"), ("get", f"/api/v1/teacher/students/{sid}/review-schedules"),
        ("patch", f"/api/v1/teacher/review-schedules/{sch.pk}"), ("get", f"/api/v1/parent/children/{sid}/progress"),
        ("get", f"/api/v1/admin/users/{sid}"), ("post", f"/api/v1/admin/users/{sid}/setup-link"),
        ("post", f"/api/v1/admin/users/{sid}/status"), ("get", "/api/v1/admin/progress"), ("get", "/api/v1/admin/audit"),
    ]
    strangers = {"other student": world.s2, "other teacher": world.t2, "unlinked parent": make_user("p9@x.test", role="parent")}
    spare = occurrence(world.t1, in_hours=72).pk
    leaks = []
    for who, user in strangers.items():
        c = client_for(user)
        own_media = upload(c).json().get("id") if user.role == "student" else None
        for i, (method, url) in enumerate(calls):
            # A complete, valid payload, so the answer reflects the ownership check rather than missing input.
            body = {"reason": "سبب كافٍ", "status": "suspended", "media": own_media or "", "occurrence": spare, **FB}
            if method == "get":
                body = {}
            r = getattr(c, method)(url, body, format="json", HTTP_IDEMPOTENCY_KEY=f"sweep-{who}-{i}")
            if r.status_code not in (403, 404, 405):
                leaks.append((who, method, url, r.status_code))
    assert leaks == []
    # The owner and the right teacher still can (the sweep is not passing because everything is closed).
    assert s1.get(f"/api/v1/submissions/{sub}").status_code == 200
    assert client_for(world.t1).get(f"/api/v1/teacher/students/{sid}/progress").status_code == 200
    assert client_for(world.p1).get(f"/api/v1/parent/children/{sid}/progress").status_code == 200


def test_password_hash_fits_small_instances_and_old_hashes_upgrade(settings):
    from django.contrib.auth.hashers import Argon2PasswordHasher, check_password, identify_hasher, make_password

    from apps.accounts.hashers import SmallArgon2PasswordHasher

    settings.PASSWORD_HASHERS = ["apps.accounts.hashers.SmallArgon2PasswordHasher", "django.contrib.auth.hashers.PBKDF2PasswordHasher"]
    new = make_password("correct horse 9")
    assert identify_hasher(new).algorithm == "argon2" and "m=19456,t=2,p=1" in new
    old = Argon2PasswordHasher().encode("correct horse 9", "saltsaltsalt")  # Django default (m=102400, p=8)
    upgraded = []
    assert check_password("correct horse 9", old, setter=lambda raw: upgraded.append(make_password(raw)))
    assert upgraded and "m=19456" in upgraded[0]
    assert not check_password("wrong", new)
    assert SmallArgon2PasswordHasher.memory_cost <= 32 * 1024


def test_ayah_audio_is_off_until_a_source_is_approved(client, settings):
    """Owner decision (16 October 2026): no unlicensed recitation audio. Off by default, no audio host allowed."""
    from apps.core.middleware import build_csp

    assert client.get("/api/v1/settings/public").json()["ayah_audio"] is None
    assert "everyayah" not in build_csp() and "alquran" not in build_csp()
    settings.AYAH_AUDIO_URL = "https://audio.example.org/r/{surah}{ayah}.mp3"
    settings.AYAH_AUDIO_NAME = "قارئ مرخّص"
    assert client.get("/api/v1/settings/public").json()["ayah_audio"] == {"url": settings.AYAH_AUDIO_URL, "name": "قارئ مرخّص"}
    media = build_csp().split("media-src")[1].split(";")[0]
    assert "https://audio.example.org" in media
