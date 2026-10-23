# Waiting list / make-up e2e: Sara takes the first open individual slot 2–6 days ahead with teacher@halqa.app, and
# Yousef has a past absence with an approved excuse (eligible for a make-up session).
from datetime import timedelta
from django.utils import timezone
from apps.accounts.models import User
from apps.scheduling import services
from apps.scheduling.models import Booking, BookingExcuse, SessionOccurrence
t = User.objects.get(email="teacher@halqa.app")
sara, yousef = User.objects.get(email="sara@halqa.app"), User.objects.get(email="yousef@halqa.app")
now = timezone.now()
occ = (SessionOccurrence.objects.filter(teacher=t, status="scheduled", capacity=1, circle__isnull=True,
                                        starts_at__gte=now + timedelta(days=2), starts_at__lte=now + timedelta(days=6))
       .exclude(bookings__status="confirmed").order_by("starts_at").first())
services.book(student=sara, occurrence_id=occ.pk, idempotency_key="e2e-waitlist-sara")
past = SessionOccurrence.objects.create(teacher=t, starts_at=now - timedelta(days=2), ends_at=now - timedelta(days=2) + timedelta(minutes=45))
b = Booking.objects.create(occurrence=past, student=yousef, idempotency_key="e2e-makeup-past", attendance="excused")
BookingExcuse.objects.create(booking=b, student=yousef, reason="مرض", status="approved")
print(occ.pk, b.pk)
