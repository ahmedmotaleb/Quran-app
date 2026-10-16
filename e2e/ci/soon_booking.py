# A confirmed booking for Yousef with teacher@halqa.app starting in 5 minutes (join window open), no meeting link yet.
from datetime import timedelta
from django.utils import timezone
from apps.accounts.models import User
from apps.scheduling.models import Booking, SessionOccurrence
t = User.objects.get(email="teacher@halqa.app"); s = User.objects.get(email="yousef@halqa.app")
start = (timezone.now() + timedelta(minutes=5)).replace(second=0, microsecond=0)
end = start + timedelta(minutes=45)
# Free the time: unbooked generated slots that overlap are closed, as a teacher would.
SessionOccurrence.objects.filter(teacher=t, starts_at__lt=end, ends_at__gt=start, status="scheduled").exclude(bookings__status="confirmed").update(status="cancelled")
o, _ = SessionOccurrence.objects.get_or_create(teacher=t, starts_at=start, defaults={"ends_at": end})
Booking.objects.get_or_create(occurrence=o, student=s, status="confirmed", defaults={"idempotency_key": f"soon-{o.pk}"})
