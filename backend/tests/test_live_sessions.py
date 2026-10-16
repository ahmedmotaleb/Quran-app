"""Pack prompt 19: live sessions through a meeting link the teacher pastes (no custom video)."""
import pytest

from apps.core.models import AuditEvent
from apps.scheduling.meeting import InvalidMeetingLink, provider_for
from apps.scheduling.models import Booking

from .conftest import client_for, occurrence

pytestmark = pytest.mark.django_db
MEET = "https://meet.google.com/abc-defg-hij"


@pytest.mark.parametrize("url,provider", [
    (MEET, "google_meet"), ("https://us02web.zoom.us/j/8312345678?pwd=Abc123", "zoom"), ("https://meet.jit.si/HalqaRoom42", "jitsi"),
    ("https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0", "teams"),
])
def test_known_providers_accepted(url, provider):
    assert provider_for(url) == provider


@pytest.mark.parametrize("url", [
    "http://meet.google.com/abc-defg-hij", "javascript:alert(1)", "https://evil.example/meet.google.com", "https://meet.google.com.evil.example/x",
    "https://user:pw@meet.jit.si/room", "https://meet.google.com/", "https://zoom.us/s/8312345678?zak=SECRET",
    "https://us02web.zoom.us/j/1?zak=SECRET", "https://meet.google.com:8443/abc-defg-hij", "", "https://" + "a" * 600,
])
def test_unsafe_or_unknown_links_refused(url):
    with pytest.raises(InvalidMeetingLink):
        provider_for(url)


def test_teacher_sets_link_on_own_upcoming_session_only(world):
    o, other = occurrence(world.t1, in_hours=5), occurrence(world.t2, in_hours=5)
    t1 = client_for(world.t1)
    r = t1.put(f"/api/v1/teacher/occurrences/{o.id}/meeting", {"url": MEET}, format="json")
    assert r.status_code == 200 and r.json()["meeting_url"] == MEET and r.json()["meeting_provider"] == "google_meet"
    assert t1.put(f"/api/v1/teacher/occurrences/{other.id}/meeting", {"url": MEET}, format="json").status_code == 404
    bad = t1.put(f"/api/v1/teacher/occurrences/{o.id}/meeting", {"url": "https://zoom.us/s/1?zak=x"}, format="json")
    assert bad.status_code == 400 and "رابط المضيف" in bad.json()["fields"]["url"][0]
    assert client_for(world.s1).put(f"/api/v1/teacher/occurrences/{o.id}/meeting", {"url": MEET}, format="json").status_code == 403
    ev = AuditEvent.objects.get(action="occurrence.meeting_link_set")
    assert MEET not in str(ev.data)  # the link is not copied into the audit log
    assert t1.put(f"/api/v1/teacher/occurrences/{o.id}/meeting", {"url": ""}, format="json").json()["meeting_url"] == ""
    past = occurrence(world.t1, in_hours=-3)
    assert t1.put(f"/api/v1/teacher/occurrences/{past.id}/meeting", {"url": MEET}, format="json").json()["code"] == "closed"


def _booked(world, in_hours, link=MEET, **kw):
    o = occurrence(world.t1, in_hours=in_hours, meeting_url=link, meeting_provider="google_meet" if link else "", **kw)
    return Booking.objects.create(occurrence=o, student=world.s1, idempotency_key=f"k{o.id}")


def join(user, b):
    return client_for(user).post(f"/api/v1/bookings/{b.id}/join")


def test_student_joins_only_inside_the_window(world):
    now_b = _booked(world, in_hours=0.1)  # starts in 6 minutes; the window opens 10 minutes before
    r = join(world.s1, now_b)
    assert r.status_code == 200 and r.json() == {"url": MEET, "provider": "google_meet", "provider_label": "Google Meet"}
    assert AuditEvent.objects.filter(action="booking.joined").count() == 1
    lst = client_for(world.s1).get("/api/v1/bookings?when=upcoming").json()["results"]
    assert lst[0]["can_join"] is True and lst[0]["has_meeting_link"] is True and "meeting_url" not in str(lst)
    assert join(world.s1, _booked(world, in_hours=3)).json()["code"] == "too_early"
    assert join(world.s1, _booked(world, in_hours=-2)).json()["code"] == "ended"
    assert join(world.s1, _booked(world, in_hours=-0.2, link="", minutes=15)).json()["code"] == "no_link"


def test_cancelled_wrong_user_and_parents_cannot_join(world):
    b = _booked(world, in_hours=0.1)
    for u in (world.s2, world.t1, world.t2):
        assert join(u, b).status_code in (403, 404)
    assert join(world.p1, b).status_code in (403, 404)  # parents: no join control (policy)
    assert client_for(world.p1).get("/api/v1/bookings").json()["results"][0]["can_join"] is False
    b.status = Booking.Status.CANCELLED
    b.save()
    assert join(world.s1, b).json()["code"] == "cancelled"
    b2 = _booked(world, in_hours=0.15, status="cancelled")  # the teacher cancelled the whole session
    assert join(world.s1, b2).json()["code"] == "cancelled"


def test_teacher_sees_own_link_students_never_see_it_in_lists(world):
    b = _booked(world, in_hours=5)
    assert client_for(world.t1).get("/api/v1/teacher/occurrences").json()[0]["meeting_url"] == MEET
    assert MEET not in client_for(world.s1).get("/api/v1/bookings").content.decode()
    assert MEET not in client_for(world.s1).get(f"/api/v1/bookings/{b.id}").content.decode()
    assert MEET not in client_for(world.s1).get(f"/api/v1/teachers/{world.t1.pk}/slots").content.decode()
