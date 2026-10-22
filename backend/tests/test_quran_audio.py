"""Ayah audio from the licensed Quran Foundation Content API (network mocked: tests never call the real service)."""
import json
import urllib.error

import pytest
from rest_framework.test import APIClient

from apps.core.middleware import build_csp
from apps.quran import qf_audio

from .conftest import client_for

pytestmark = pytest.mark.django_db


@pytest.fixture
def qf(settings, monkeypatch):
    settings.QF_CLIENT_ID, settings.QF_CLIENT_SECRET, settings.QF_ENV, settings.QF_RECITATION_ID = "cid", "secret", "prelive", 7
    settings.QF_RECITERS = [(7, "مشاري راشد العفاسي"), (12, "محمود خليل الحصري — المصحف المعلم")]
    calls = []
    pages = {
        1: {"audio_files": [{"verse_key": f"2:{i}", "url": f"Alafasy/mp3/002{i:03d}.mp3"} for i in range(1, 51)], "pagination": {"next_page": 2}},
        2: {"audio_files": [{"verse_key": "2:51", "url": "https://evil.example/x.mp3"},          # foreign host: dropped
                            {"verse_key": "2:52", "url": "//verses.quran.foundation/Alafasy/mp3/002052.mp3"},
                            {"verse_key": "1:1", "url": "Alafasy/mp3/001001.mp3"}],                # other surah: dropped
            "pagination": {"next_page": None}},
    }

    def fake(req):
        calls.append(req)
        if req.full_url.endswith("/oauth2/token"):
            assert req.full_url.startswith("https://prelive-oauth2.quran.foundation/")
            assert req.headers["Authorization"].startswith("Basic ") and req.data == b"grant_type=client_credentials&scope=content"
            return {"access_token": f"tok{len(calls)}", "expires_in": 3600}
        assert req.full_url.startswith(("https://apis-prelive.quran.foundation/content/api/v4/recitations/7/by_chapter/",
                                        "https://apis-prelive.quran.foundation/content/api/v4/recitations/12/by_chapter/"))
        assert req.headers["X-client-id"] == "cid" and req.headers["X-auth-token"].startswith("tok")
        if "/by_chapter/3?" in req.full_url:
            return {"audio_files": [], "pagination": {"next_page": None}}
        return pages[int(req.full_url.split("page=")[-1])]

    monkeypatch.setattr(qf_audio, "_http", fake)
    return calls


def test_surah_audio_urls_are_absolute_filtered_and_cached(world, qf):
    c = client_for(world.s1)
    r = c.get("/api/v1/quran/audio/2")
    assert r.status_code == 200, r.content
    d = r.json()
    assert d["reciter"] and "Quran" in d["source"]
    assert d["ayahs"]["1"] == "https://verses.quran.foundation/Alafasy/mp3/002001.mp3"
    assert d["ayahs"]["52"] == "https://verses.quran.foundation/Alafasy/mp3/002052.mp3"
    assert "51" not in d["ayahs"] and len(d["ayahs"]) == 51  # the foreign-host URL never reaches the browser
    n = len(qf)
    assert c.get("/api/v1/quran/audio/2").status_code == 200 and len(qf) == n  # served from the one-day cache
    assert sum(1 for x in qf if x.full_url.endswith("/oauth2/token")) == 1     # token reused


def test_prelive_surah_without_audio_and_bad_numbers(world, qf):
    c = client_for(world.s1)
    r = c.get("/api/v1/quran/audio/3")
    assert r.status_code == 404 and "للفاتحة والبقرة" in r.json()["message"]
    assert c.get("/api/v1/quran/audio/115").status_code == 404
    assert APIClient().get("/api/v1/quran/audio/2").status_code in (401, 403)  # not an open proxy


def test_expired_token_is_renewed_once_and_outages_are_reported(world, qf, monkeypatch):
    real = qf_audio._http
    state = {"n": 0}

    def flaky(req):
        if "/by_chapter/" in req.full_url and state["n"] == 0:
            state["n"] += 1
            raise urllib.error.HTTPError(req.full_url, 401, "expired", {}, None)
        return real(req)
    monkeypatch.setattr(qf_audio, "_http", flaky)
    assert client_for(world.s1).get("/api/v1/quran/audio/2").status_code == 200

    def down(req):
        raise urllib.error.URLError("no route")
    monkeypatch.setattr(qf_audio, "_http", down)
    from django.core.cache import cache
    cache.clear()
    r = client_for(world.s1).get("/api/v1/quran/audio/1")
    assert r.status_code == 503 and r.json()["code"] == "audio_unavailable"


def test_off_without_keys_and_public_settings_csp_readiness(world, settings, client):
    settings.QF_CLIENT_ID = settings.QF_CLIENT_SECRET = ""
    settings.AYAH_AUDIO_URL = ""
    assert client_for(world.s1).get("/api/v1/quran/audio/1").status_code == 503
    assert client.get("/api/v1/settings/public").json()["ayah_audio"] is None
    assert "quran.foundation" not in build_csp()
    settings.QF_CLIENT_ID, settings.QF_CLIENT_SECRET = "cid", "secret"
    pub = client.get("/api/v1/settings/public").json()
    assert pub["ayah_audio"]["provider"] == "qf" and "Quran.com" in pub["ayah_audio"]["name"]
    assert "secret" not in json.dumps(pub) and "cid" not in json.dumps(pub)        # credentials never leave the server
    assert "https://verses.quran.foundation" in build_csp().split("media-src")[1].split(";")[0]
    assert client.get("/api/ready").json()["features"]["ayah_audio"] == "quran_foundation_prelive"


def test_requests_carry_a_named_user_agent(monkeypatch):
    """CDN firewalls often refuse Python's default agent; every QF request names the app."""
    import io
    import urllib.request

    seen = {}

    class R(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=0):
        seen["ua"] = req.get_header("User-agent")
        return R(b'{"ok": true}')
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    assert qf_audio._http(urllib.request.Request("https://apis-prelive.quran.foundation/x")) == {"ok": True}
    assert seen["ua"].startswith("HalqaQuranApp/")


def test_check_command_reports_ok_and_failure(qf, monkeypatch, settings):
    from io import StringIO

    from django.core.management import CommandError, call_command

    out = StringIO()
    call_command("check_quran_audio", "--surah", "2", stdout=out)
    assert "51 ayah audio files (prelive)" in out.getvalue() and "verses.quran.foundation" in out.getvalue()

    def down(req):
        raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, None)
    monkeypatch.setattr(qf_audio, "_http", down)
    from django.core.cache import cache
    cache.clear()
    with pytest.raises(CommandError):
        call_command("check_quran_audio")
    settings.QF_CLIENT_ID = ""
    with pytest.raises(CommandError, match="not configured"):
        call_command("check_quran_audio")


def test_reciter_choice_is_limited_to_the_offered_list_and_cached_separately(world, qf, settings):
    c = client_for(world.s1)
    a = c.get("/api/v1/quran/audio/2?reciter=12")
    assert a.status_code == 200 and a.json()["reciter_id"] == 12 and "الحصري" in a.json()["reciter"]
    assert any("/recitations/12/" in x.full_url for x in qf)
    b = c.get("/api/v1/quran/audio/2")
    assert b.json()["reciter_id"] == 7 and any("/recitations/7/" in x.full_url for x in qf)  # its own cache entry
    bad = c.get("/api/v1/quran/audio/2?reciter=99")
    assert bad.status_code == 400 and not any("/recitations/99/" in x.full_url for x in qf)
    pub = APIClient().get("/api/v1/settings/public").json()["ayah_audio"]
    assert pub["default"] == 7 and [r["id"] for r in pub["reciters"]] == [7, 12]


def test_default_reciter_is_husary_muallim():
    from django.conf import settings as s

    if not __import__("os").environ.get("QF_RECITERS"):
        assert s.QF_RECITERS[0][0] == 12 and "المعلم" in s.QF_RECITERS[0][1]
