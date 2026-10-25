# Waiting list / make-up e2e: Sara takes the first free individual time 2–6 days ahead with teacher@halqa.app, and
# Yousef has a past absence with an approved excuse (eligible for a make-up session).
from datetime import timedelta
from django.utils import timezone
from apps.accounts.models import User
from apps.scheduling import services
from apps.scheduling.models import Booking, BookingExcuse, SessionOccurrence
t = User.objects.get(email="teacher@halqa.app")
sara, yousef = User.objects.get(email="sara@halqa.app"), User.objects.get(email="yousef@halqa.app")
now = timezone.now()
# The first time computed from the teacher's availability 2–6 days ahead (scheduling/availability.py).
from apps.scheduling import availability as av
slot = av.compute(t, now + timedelta(days=2), now + timedelta(days=6), google_live=False)[0]
booking, _ = services.book_slot(student=sara, token=av.token_for(t.pk, slot.start, slot.minutes), idempotency_key="e2e-waitlist-sara")
occ = booking.occurrence
past = SessionOccurrence.objects.create(teacher=t, starts_at=now - timedelta(days=2), ends_at=now - timedelta(days=2) + timedelta(minutes=45))
b = Booking.objects.create(occurrence=past, student=yousef, idempotency_key="e2e-makeup-past", attendance="excused")
BookingExcuse.objects.create(booking=b, student=yousef, reason="مرض", status="approved")
print(occ.pk, b.pk)
