"""«الأذكار والأدعية» — library, review gate, scheduled reminders, settings, administration.

The Quran text here is the test fixture's PLACEHOLDER strings (tests/test_quran.py), never real or imitation verses:
the point is that Quranic entries copy their text from the verified source and never from a request.
"""
import json
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone

import pytest
from django.utils import timezone

from apps.adhkar import seed, services
from apps.adhkar.models import Delivery, Dhikr, Preferences
from apps.notifications.models import Notification, PushSubscription
from apps.quran.importer import import_source, parse_tanzil

from .conftest import client_for, make_user
from .test_admins import staff
from .test_push import FakePush, keys  # noqa: F401  (fixture)
from .test_quran import fixture_file

pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("commit_now")]
A = "/api/v1/admin/adhkar"


@pytest.fixture
def quran():
    return import_source(parsed=parse_tanzil(fixture_file()), slug="test-src", name="Test", edition="Fixture", version="0",
                         source_url="", license_name="test", meta={}, activate=True)


def phone(u, n=1):
    return PushSubscription.objects.create(user=u, endpoint=f"https://fcm.googleapis.com/fcm/send/{u.pk}-{n}", p256dh="p", auth="a", device="Android")


def hadith(**kw):
    base = dict(category="dhikr", source_type="hadith", text="نص اختبار من المصدر", hadith_collection="صحيح البخاري", hadith_number="1",
                grading="sahih", status="approved")
    return Dhikr.objects.create(**{**base, **kw})


def at(local_iso, tz="Africa/Cairo"):
    from zoneinfo import ZoneInfo

    return datetime.fromisoformat(local_iso).replace(tzinfo=ZoneInfo(tz)).astimezone(dt_timezone.utc)


# ---- verified content only ------------------------------------------------------------------------------------------
def test_quran_references_take_their_text_from_the_verified_source_and_wait_for_review(world, quran):
    r = seed.seed_quran()
    total = sum(len(v) for v in seed.QURAN_REFERENCES.values())
    assert r["created"] == total and r["missing"] == []
    d = Dhikr.objects.get(source_type="quran", surah=2, ayah_from=201)
    assert d.text == "PLACEHOLDER-2-201 ﴿٢٠١﴾" and d.status == "pending" and d.quran_source == quran and d.category == "quran_dua"
    rng = Dhikr.objects.get(surah=20, ayah_from=25)
    assert rng.text.count("PLACEHOLDER-20-") == 4                                            # 25–28, each ayah numbered
    assert seed.seed_quran()["created"] == 0                                                 # idempotent
    assert client_for(world.s1).get("/api/v1/adhkar").json()["results"] == []                # nothing shown before approval


def test_every_proposed_reference_exists_in_the_hafs_count(world):
    from apps.quran.models import HAFS_AYAH_COUNTS

    for refs in seed.QURAN_REFERENCES.values():
        for s, a, b in refs:
            assert 1 <= s <= 114 and 1 <= a <= b <= HAFS_AYAH_COUNTS[s - 1], (s, a, b)


def test_without_a_verified_quran_text_nothing_is_invented(world):
    r = seed.seed_quran()
    assert r["created"] == 0 and len(r["missing"]) > 0 and not Dhikr.objects.exists()


def test_admin_flow_create_review_edit_enable(world, quran):
    content = staff("content@x.test", preset="content")                    # may add/edit, may NOT approve
    c, owner = client_for(content), client_for(world.admin)
    # Quranic: the text in the request is ignored; it comes from the verified source
    r = c.post(A, {"category": "quran_dua", "source_type": "quran", "surah": 2, "ayah_from": 201, "ayah_to": 201, "text": "نص مخترع"}, format="json")
    assert r.status_code == 201 and r.json()["text"] == "PLACEHOLDER-2-201 ﴿٢٠١﴾" and r.json()["status"] == "pending"
    qid = r.json()["id"]
    assert c.post(A, {"category": "quran_dua", "source_type": "quran", "surah": 2, "ayah_from": 201}, format="json").status_code == 409
    bad = c.post(A, {"category": "quran_dua", "source_type": "quran", "surah": 1, "ayah_from": 7, "ayah_to": 9}, format="json")
    assert bad.status_code == 400 and bad.json()["fields"]["ayah_to"]                     # al-Fatiha has 7 ayahs
    # Hadith: collection, number and Sahih/Hasan grading are required
    r = c.post(A, {"category": "sunnah_dua", "source_type": "hadith", "text": "نص من المصدر"}, format="json")
    assert r.status_code == 400 and set(r.json()["fields"]) >= {"hadith_collection", "hadith_number", "grading"}
    r = c.post(A, {"category": "sunnah_dua", "source_type": "hadith", "text": "نص من المصدر", "hadith_collection": "صحيح مسلم",
                   "hadith_number": "2691", "grading": "sahih", "repetition": 100, "time_of_day": "morning"}, format="json")
    assert r.status_code == 201
    hid = r.json()["id"]
    assert r.json()["source"] == "صحيح مسلم (٢٦٩١) · صحيح"
    # review: only adhkar.approve; a rejection needs a reason
    assert c.post(f"{A}/{hid}/review", {"decision": "approve"}, format="json").status_code == 403
    assert owner.post(f"{A}/{hid}/review", {"decision": "reject"}, format="json").status_code == 400
    assert owner.post(f"{A}/{hid}/review", {"decision": "approve"}, format="json").json()["status"] == "approved"
    assert owner.post(f"{A}/{qid}/review", {"decision": "approve"}, format="json").json()["reviewed_by"]
    ids = [x["id"] for x in client_for(world.s1).get("/api/v1/adhkar").json()["results"]]
    assert set(ids) == {qid, hid}
    # changing the source sends it back to review (and hides it); a note change does not
    r = c.patch(f"{A}/{hid}", {"hadith_number": "2692"}, format="json")
    assert r.json()["status"] == "pending"
    assert hid not in [x["id"] for x in client_for(world.s1).get("/api/v1/adhkar").json()["results"]]
    assert c.patch(f"{A}/{qid}", {"time_of_day": "evening"}, format="json").json()["status"] == "approved"
    # disabled entries are hidden too
    c.post(f"{A}/{qid}/enable", {"enabled": False}, format="json")
    assert client_for(world.s1).get("/api/v1/adhkar").json()["results"] == []
    assert client_for(world.s1).get(A).status_code == 403                                  # learners never reach admin APIs


# ---- reading, favorites, settings -----------------------------------------------------------------------------------
def test_library_search_category_favorites_for_every_role(world, quran):
    d = hadith(category="istighfar", text="أَسْتَغْفِرُ اللَّهَ نص اختبار")
    hadith(category="tasbih", text="سُبْحَانَ اللَّهِ نص اختبار", hadith_number="2")
    for u in (world.s1, world.t1, world.p1, world.admin):
        r = client_for(u).get("/api/v1/adhkar", {"category": "istighfar"}).json()
        assert [x["id"] for x in r["results"]] == [d.pk]
    assert [x["id"] for x in client_for(world.s1).get("/api/v1/adhkar", {"q": "استغفر"}).json()["results"]] == [d.pk]   # without diacritics
    c = client_for(world.s1)
    c.post(f"/api/v1/adhkar/{d.pk}/favorite")
    assert [x["id"] for x in c.get("/api/v1/adhkar", {"favorites": "1"}).json()["results"]] == [d.pk]
    assert client_for(world.s2).get("/api/v1/adhkar", {"favorites": "1"}).json()["results"] == []   # per account
    assert c.get(f"/api/v1/adhkar/{d.pk}").json()["favorite"] is True


def test_settings_persist_and_validate(world):
    c = client_for(world.t1)
    s = c.get("/api/v1/me/adhkar-settings").json()
    assert s["enabled"] and s["interval_hours"] == 2 and (s["window_start"], s["window_end"]) == (8, 22)
    assert c.put("/api/v1/me/adhkar-settings", {"interval_hours": 5}, format="json").status_code == 400
    assert c.put("/api/v1/me/adhkar-settings", {"window_start": 22, "window_end": 8}, format="json").status_code == 400
    r = c.put("/api/v1/me/adhkar-settings", {"interval_hours": 3, "morning_hour": 6, "sunnah_dua_on": False}, format="json")
    assert r.status_code == 200
    assert client_for(world.t1).get("/api/v1/me/adhkar-settings").json()["interval_hours"] == 3   # another session, same account
    assert Preferences.objects.get(user=world.t1).morning_hour == 6


# ---- scheduled reminders --------------------------------------------------------------------------------------------
def test_periodic_reminder_every_two_hours_in_the_window_rotates_without_repeats(world, keys, monkeypatch):  # noqa: F811
    fake = FakePush(monkeypatch)
    a, b, c = hadith(text="نص أ"), hadith(text="نص ب", hadith_number="2"), hadith(text="نص ج", hadith_number="3")
    phone(world.s1)
    seen = []
    for h in ("08:23", "09:23", "10:23", "12:23", "14:23"):          # 09:23 is not an every-2-hours slot from 08:00
        services.run(at(f"2026-11-13T{h}"))
    seen = list(Delivery.objects.filter(user=world.s1).order_by("sent_at").values_list("dhikr_id", flat=True))
    assert len(seen) == 4 and set(seen[:3]) == {a.pk, b.pk, c.pk} and seen[3] == seen[0]   # all three before any repeat
    p = fake.sent[0][1]
    assert p["title"] == "الحلقة | ذكر الله" and "\n" in p["body"] and p["url"].startswith("/#/n/") and "r" in p
    assert "صحيح البخاري" in p["body"]


def test_same_hour_twice_dst_and_quiet_hours_never_duplicate(world, keys, monkeypatch):  # noqa: F811
    FakePush(monkeypatch)
    hadith()
    phone(world.s1)
    services.run(at("2026-11-13T10:23")); services.run(at("2026-11-13T10:50"))
    assert Delivery.objects.filter(user=world.s1).count() == 1
    # 29 Oct 2026: Cairo's 23:xx happens twice — quiet hours by default; with quiet hours off and a window to 24, once.
    Preferences.objects.create(user=world.s2, quiet_start=0, quiet_end=0, window_start=0, window_end=24, interval_hours=1, morning_on=False,
                               evening_on=False, sleep_on=False)
    phone(world.s2)
    services.run(datetime(2026, 10, 29, 20, 30, tzinfo=dt_timezone.utc))   # 23:30 +03
    services.run(datetime(2026, 10, 29, 21, 30, tzinfo=dt_timezone.utc))   # 23:30 +02 again
    assert Delivery.objects.filter(user=world.s2).count() == 1
    # quiet hours (default 23:00–06:00): nothing for s1 at 23:23 or 02:23
    services.run(at("2026-11-13T23:23")); services.run(at("2026-11-14T02:23"))
    assert Delivery.objects.filter(user=world.s1).count() == 1


def test_morning_evening_sleep_at_the_chosen_local_hour_with_catch_up(world, keys, monkeypatch):  # noqa: F811
    FakePush(monkeypatch)
    m = hadith(category="morning", time_of_day="morning", text="ذكر صباح", hadith_number="10")
    e = hadith(category="evening", time_of_day="evening", text="ذكر مساء", hadith_number="11")
    phone(world.s1)
    services.run(at("2026-11-13T06:23"))                                   # before 07:00 (and in quiet hours)
    assert not Delivery.objects.exists()
    services.run(at("2026-11-13T09:05"))                                   # missed 07/08 runs: caught up within 3 h
    d = Delivery.objects.get(user=world.s1)
    assert d.dhikr == m and d.slot == "morning:2026-11-13"
    services.run(at("2026-11-13T17:23"))
    assert Delivery.objects.filter(user=world.s1, dhikr=e, slot="evening:2026-11-13").exists()
    # Riyadh user at 07:23 local (04:23 UTC) gets the morning one; a Cairo user at that instant (06:23) does not
    world.t1.timezone = "Asia/Riyadh"; world.t1.save(update_fields=["timezone"])
    phone(world.t1)
    services.run(at("2026-11-14T07:23", "Asia/Riyadh"))
    assert Delivery.objects.filter(user=world.t1, slot="morning:2026-11-14").exists()
    assert not Delivery.objects.filter(user=world.s1, slot="morning:2026-11-14").exists()


def test_only_approved_enabled_content_and_off_switches(world, keys, monkeypatch):  # noqa: F811
    FakePush(monkeypatch)
    hadith(status="pending")
    hadith(hadith_number="9", enabled=False)
    phone(world.s1)
    services.run(at("2026-11-13T10:23"))
    assert not Delivery.objects.exists()                                   # nothing approved+enabled: nothing sent
    hadith(hadith_number="5")
    Preferences.objects.create(user=world.s1, enabled=False)
    services.run(at("2026-11-13T12:23"))
    assert not Delivery.objects.exists()                                   # «تفعيل الأذكار» off
    Preferences.objects.filter(user=world.s1).update(enabled=True, interval_hours=0)
    services.run(at("2026-11-13T14:23"))
    assert not Delivery.objects.exists()                                   # periodic off
    sunnah = hadith(category="sunnah_dua", hadith_number="6")
    Dhikr.objects.exclude(pk=sunnah.pk).update(enabled=False)
    Preferences.objects.filter(user=world.s1).update(interval_hours=2, sunnah_dua_on=False)
    services.run(at("2026-11-13T16:23"))
    assert not Delivery.objects.exists()                                   # prophetic duas switched off


def test_accounts_are_isolated_and_other_notices_are_unaffected(world, keys, monkeypatch):  # noqa: F811
    from apps.notifications.services import notify

    fake = FakePush(monkeypatch)
    hadith()
    phone(world.s1); phone(world.t1)
    Preferences.objects.create(user=world.t1, enabled=False)
    services.run(at("2026-11-13T10:23"))
    eps = [ep for ep, _ in fake.sent]
    assert eps == [f"https://fcm.googleapis.com/fcm/send/{world.s1.pk}-1"]   # only s1's own device; t1 turned adhkar off
    notify(world.t1, "assignment_new", "x", dedupe="still-works")          # learning notices still reach t1
    assert len(fake.sent) == 2
    # adhkar notices are not inbox messages
    assert all(not n["kind"].startswith("adhkar") for n in client_for(world.s1).get("/api/v1/notifications").json()["results"])
    others = Notification.objects.filter(recipient=world.s1, read_at__isnull=True).exclude(kind__startswith="adhkar_").count()
    assert Notification.objects.filter(recipient=world.s1, kind__startswith="adhkar_").count() == 1
    assert client_for(world.s1).get("/api/v1/notifications/unread").json()["unread"] == others


def test_tap_opens_the_dhikr(world, keys, monkeypatch):  # noqa: F811
    FakePush(monkeypatch)
    d = hadith()
    phone(world.s1)
    services.run(at("2026-11-13T10:23"))
    n = Notification.objects.get(recipient=world.s1, kind__startswith="adhkar_")
    assert n.data == {"dhikr": d.pk} and n.link == f"/adhkar/{d.pk}"
    r = client_for(world.s1).get(f"/api/v1/notifications/{n.pk}").json()
    assert r["data"]["dhikr"] == d.pk                                     # the app opens it from #/n/<id>


def test_admin_stats_and_test_send(world, keys, monkeypatch):  # noqa: F811
    FakePush(monkeypatch)
    d = hadith()
    phone(world.admin)
    r = client_for(world.admin).post(f"{A}/{d.pk}/test").json()
    assert r["devices"] == 1 and r["push_status"] == "sent"
    s = client_for(world.admin).get(f"{A}/stats").json()
    assert s["notices_7d"] == 1 and s["by_push_status"] == {"sent": 1} and s["library"] == {"approved": 1}
    pend = hadith(status="pending", hadith_number="7")
    assert client_for(world.admin).post(f"{A}/{pend.pk}/test").status_code == 409
    assert "endpoint" not in json.dumps(s)


def test_source_label_names_the_surah_and_never_leaves_it_blank(world, quran):
    from apps.quran.models import Surah

    seed.seed_quran()
    d = Dhikr.objects.get(source_type="quran", surah=2, ayah_from=201)
    Surah.objects.filter(source=quran, number=2).update(name_ar="سورة البقرة")
    assert services.source_label(d) == "البقرة: ٢٠١"
    Surah.objects.filter(source=quran, number=2).update(name_ar="")                        # an import without names
    assert services.source_label(d) == "سورة ٢: ٢٠١"
    assert services.source_label(hadith()) == "صحيح البخاري (١) · صحيح"
