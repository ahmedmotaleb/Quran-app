"""PROMPT 49: support tickets. Requesters see only their own tickets and never internal notes; staff need
support.view / support.manage; screenshots only (re-encoded, EXIF dropped); recordings cannot be attached."""
from io import BytesIO, StringIO

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from PIL import Image

from apps.core.models import AuditEvent
from apps.media.models import MediaObject
from apps.notifications.models import Notification
from apps.support.models import Ticket

from .conftest import client_for
from .test_admins import staff

pytestmark = pytest.mark.django_db
T, A = "/api/v1/support/tickets", "/api/v1/admin/support/tickets"


@pytest.fixture(autouse=True)
def _private_root(settings, tmp_path):
    settings.MEDIA_STORAGE = "local"
    settings.MEDIA_LOCAL_ROOT = tmp_path / "media"


def png(w=40, h=30, exif=False, fmt="PNG", mode="RGB") -> bytes:
    im = Image.new(mode, (w, h), (10, 120, 90))
    b = BytesIO()
    if exif:
        ex = Image.Exif()
        ex[0x010F] = "SecretPhone"  # Make
        im.save(b, "JPEG", exif=ex)
    else:
        im.save(b, fmt)
    return b.getvalue()


def upload(data: bytes, name="s.png", ctype="image/png"):
    return SimpleUploadedFile(name, data, content_type=ctype)


def open_ticket(user, **kw):
    body = {"category": "technical", "subject": "التطبيق لا يفتح", "message": "تظهر شاشة بيضاء بعد تسجيل الدخول.", **kw}
    return client_for(user).post(T, body, format="multipart" if "image" in kw else "json")


def test_requester_flow_and_idor(world):
    r = open_ticket(world.s1)
    assert r.status_code == 201 and r.json()["status"] == "open" and len(r.json()["messages"]) == 1
    tid = r.json()["id"]
    assert open_ticket(world.t1).status_code == 201 and open_ticket(world.p1).status_code == 201  # teachers and parents too
    mine = client_for(world.s1).get(T).json()
    assert [t["id"] for t in mine["results"]] == [tid] and "payment" not in [c["value"] for c in mine["categories"]]
    other = client_for(world.s2)
    assert other.get(f"{T}/{tid}").status_code == 404
    assert other.post(f"{T}/{tid}/messages", {"message": "x"}, format="json").status_code == 404
    assert other.post(f"{T}/{tid}/close").status_code == 404
    assert client_for(world.p1).get(f"{T}/{tid}").status_code == 404  # the parent of s1 does not see s1's tickets
    assert client_for(world.admin).get(T).status_code == 403  # admins use the admin API
    assert open_ticket(world.s1, category="payment").status_code == 400  # reserved for later
    assert open_ticket(world.s1, subject="").status_code == 400
    assert AuditEvent.objects.filter(action="support.ticket_created", actor=world.s1).count() == 1


def test_internal_notes_never_reach_the_requester(world, django_capture_on_commit_callbacks):
    tid = open_ticket(world.s1).json()["id"]
    agent = staff("agent@x.test", "support")
    c = client_for(agent)
    with django_capture_on_commit_callbacks(execute=True):
        assert c.post(f"{A}/{tid}/messages", {"message": "ملاحظة داخلية: الحساب مرتبط بمعلم آخر", "internal": True}, format="json").status_code == 201
    assert not Notification.objects.filter(recipient=world.s1).exists()  # a note does not notify
    with django_capture_on_commit_callbacks(execute=True):
        r = c.post(f"{A}/{tid}/messages", {"message": "جرّب تحديث التطبيق ثم أخبرنا."}, format="json")
    assert r.status_code == 201 and r.json()["status"] == "waiting_user" and r.json()["assignee"]["id"] == agent.pk
    n = Notification.objects.get(recipient=world.s1)
    assert n.kind == "support_reply" and "ملاحظة داخلية" not in n.body
    me = client_for(world.s1).get(f"{T}/{tid}").json()
    text = str(me)
    assert "ملاحظة داخلية" not in text and "internal" not in text and len(me["messages"]) == 2
    assert me["messages"][1]["from_staff"] is True and me["messages"][1]["author"] is None  # «فريق الدعم», no admin name
    assert agent.full_name not in text and "assignee" not in me
    # The requester replies: back to the team.
    r = client_for(world.s1).post(f"{T}/{tid}/messages", {"message": "ما زالت المشكلة."}, format="json")
    assert r.json()["status"] == "open"
    staff_view = c.get(f"{A}/{tid}").json()
    assert [m["internal"] for m in staff_view["messages"]] == [False, True, False, False]


def test_staff_permissions_assign_state_and_resolve(world, django_capture_on_commit_callbacks):
    tid = open_ticket(world.s1).json()["id"]
    viewer = staff("viewer@x.test", perms=["support.view"])
    nobody = staff("nobody@x.test", perms=["users.view"])
    agent = staff("agent2@x.test", "support")
    assert client_for(nobody).get(A).status_code == 403 and client_for(nobody).get(f"{A}/{tid}").status_code == 403
    assert client_for(world.t1).get(A).status_code == 403
    v = client_for(viewer)
    assert v.get(A).json()["count"] == 1 and v.get(f"{A}/{tid}").status_code == 200
    assert v.post(f"{A}/{tid}/messages", {"message": "x"}, format="json").status_code == 403
    assert v.patch(f"{A}/{tid}", {"status": "closed"}, format="json").status_code == 403
    c = client_for(agent)
    assert c.patch(f"{A}/{tid}", {"assignee": nobody.pk}, format="json").status_code == 400  # cannot read tickets
    assert c.patch(f"{A}/{tid}", {"assignee": world.t1.pk}, format="json").status_code == 400
    r = c.patch(f"{A}/{tid}", {"assignee": viewer.pk, "status": "in_progress"}, format="json")
    assert r.status_code == 200 and r.json()["assignee"]["id"] == viewer.pk and r.json()["status"] == "in_progress"
    assert c.patch(f"{A}/{tid}", {"status": "bogus"}, format="json").status_code == 400
    with django_capture_on_commit_callbacks(execute=True):
        r = c.patch(f"{A}/{tid}", {"status": "resolved"}, format="json")
    assert r.json()["resolved_at"] and Notification.objects.filter(recipient=world.s1, kind="support_resolved").exists()
    ev = AuditEvent.objects.filter(action="support.ticket_updated").values_list("data", flat=True)
    assert any("assignee" in str(d) for d in ev) and any("resolved" in str(d) for d in ev)
    assert {s["id"] for s in c.get("/api/v1/admin/support/staff").json()["results"]} >= {viewer.pk, agent.pk}
    assert nobody.pk not in {s["id"] for s in c.get("/api/v1/admin/support/staff").json()["results"]}
    assert c.get("/api/v1/admin/support/counts").json()["resolved"] == 1
    assert c.get(A).json()["count"] == 0 and c.get(A, {"status": "all"}).json()["count"] == 1
    # The requester closes it; a closed ticket takes no more replies.
    assert client_for(world.s1).post(f"{T}/{tid}/close").json()["status"] == "closed"
    assert client_for(world.s1).post(f"{T}/{tid}/messages", {"message": "x"}, format="json").status_code == 409


def test_screenshot_attachment_is_reencoded_and_private(world):
    r = open_ticket(world.s1, image=upload(png(exif=True, fmt="JPEG"), "p.jpg", "image/jpeg"))
    assert r.status_code == 201
    att = r.json()["messages"][0]["attachment"]
    m = MediaObject.objects.get(pk=att["id"])
    assert m.purpose == "support_image" and m.content_type == "image/jpeg" and m.owner == world.s1
    from apps.media.storage import get_storage

    stored = get_storage().open(m.key).read()
    assert b"SecretPhone" not in stored and Image.open(BytesIO(stored)).format == "JPEG"  # EXIF dropped
    # Who may read it: the requester and support staff; not the student's teacher, parent, or other admins.
    assert client_for(world.s1).get(f"/api/v1/media/{m.pk}").status_code == 200
    assert client_for(staff("sv@x.test", perms=["support.view"])).get(f"/api/v1/media/{m.pk}").status_code == 200
    for u in (world.t1, world.p1, world.s2, staff("subs@x.test", perms=["submissions.view"])):
        assert client_for(u).get(f"/api/v1/media/{m.pk}").status_code == 404
    # PNG with transparency stays PNG.
    r = open_ticket(world.s1, image=upload(png(mode="RGBA")))
    assert MediaObject.objects.get(pk=r.json()["messages"][0]["attachment"]["id"]).content_type == "image/png"


def test_attachment_validation(world, settings):
    from apps.media import services

    audio = b"\x1a\x45\xdf\xa3" + b"\0" * 400
    assert open_ticket(world.s1, image=upload(audio, "r.webm", "audio/webm")).status_code == 400  # not an image type
    assert open_ticket(world.s1, image=upload(audio, "fake.png", "image/png")).status_code == 400  # bytes are not an image
    assert open_ticket(world.s1, image=upload(b"%PDF-1.4 " + b"x" * 100, "d.png", "image/png")).status_code == 400
    gif = BytesIO(); Image.new("RGB", (5, 5)).save(gif, "GIF")
    assert open_ticket(world.s1, image=upload(gif.getvalue(), "a.png", "image/png")).status_code == 400  # GIF disguised
    big = upload(b"\x89PNG" + b"0" * (services.SUPPORT_IMAGE_MAX_BYTES + 1))
    assert open_ticket(world.s1, image=big).status_code == 413
    settings_px = services.SUPPORT_IMAGE_MAX_PIXELS
    services.SUPPORT_IMAGE_MAX_PIXELS = 100
    try:
        assert open_ticket(world.s1, image=upload(png(200, 200))).status_code == 400  # decompression-bomb guard
    finally:
        services.SUPPORT_IMAGE_MAX_PIXELS = settings_px
    # An existing recording cannot be attached by id.
    rec = MediaObject.objects.create(owner=world.s1, purpose="recitation", key="rec/x.webm", content_type="audio/webm", state="validated")
    assert open_ticket(world.s1, attachment=str(rec.pk)).status_code == 400
    assert not Ticket.objects.exists() and not MediaObject.objects.filter(purpose="support_image").exists()
    settings.MEDIA_STORAGE = "none"
    assert open_ticket(world.s1, image=upload(png())).status_code == 503
    assert not Ticket.objects.exists()


def test_account_deletion_removes_ticket_text_and_screenshots(world):
    r = open_ticket(world.s1, image=upload(png()))
    mid = r.json()["messages"][0]["attachment"]["id"]
    from apps.accounts.erase import erase_user

    assert erase_user(world.s1, world.admin) == "anonymized"  # the ticket keeps the row
    assert MediaObject.objects.get(pk=mid).state == "deleted"
    t = client_for(staff("sv2@x.test", perms=["support.view"])).get(f"{A}/{r.json()['id']}").json()
    assert t["messages"][0]["attachment"] is None and t["status"] == "closed"
    assert "شاشة بيضاء" not in str(t) and "لا يفتح" not in str(t)


def test_purge_orphans_keeps_support_images(world):
    from datetime import timedelta

    from django.core.management import call_command
    from django.utils import timezone

    r = open_ticket(world.s1, image=upload(png()))
    MediaObject.objects.filter(purpose="support_image").update(created_at=timezone.now() - timedelta(days=5))
    call_command("purge_orphan_media", stdout=StringIO())
    assert MediaObject.objects.get(pk=r.json()["messages"][0]["attachment"]["id"]).state == "validated"


def test_write_rate_limit(world, settings):
    from django.core.cache import cache

    settings.REST_FRAMEWORK = {**settings.REST_FRAMEWORK, "DEFAULT_THROTTLE_RATES": {**settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"], "support": "2/hour"}}
    from rest_framework.throttling import ScopedRateThrottle

    old = ScopedRateThrottle.THROTTLE_RATES
    ScopedRateThrottle.THROTTLE_RATES = settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]
    cache.clear()
    try:
        assert open_ticket(world.s1).status_code == 201 and open_ticket(world.s1).status_code == 201
        assert open_ticket(world.s1).status_code == 429
        assert client_for(world.s1).get(T).status_code == 200  # reading is not limited
    finally:
        ScopedRateThrottle.THROTTLE_RATES = old


def test_admin_search_and_filters(world):
    open_ticket(world.s1, subject="مشكلة في الحجز", category="booking")
    open_ticket(world.s2)
    c = client_for(staff("f@x.test", "support"))
    assert c.get(A, {"category": "booking"}).json()["count"] == 1
    assert c.get(A, {"q": "الحجز"}).json()["count"] == 1
    assert c.get(A, {"q": world.s2.full_name}).json()["count"] == 1
    assert c.get(A, {"assignee": "none"}).json()["count"] == 2
    assert c.get(A, {"status": "nope"}).status_code == 400


def test_csp_allows_signed_screenshots_from_r2_only():
    from apps.core.middleware import build_csp

    img = build_csp().split("img-src")[1].split(";")[0].split()
    assert img == ["'self'", "data:", "blob:", "https://*.r2.cloudflarestorage.com"]
