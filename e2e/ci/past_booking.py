# A confirmed booking for Yousef with teacher@halqa.app that started 2 hours ago (for attendance checks).
from datetime import timedelta
from django.utils import timezone
from apps.accounts.models import User
from apps.scheduling.models import Booking, SessionOccurrence
t = User.objects.get(email="teacher@halqa.app"); s = User.objects.get(email="yousef@halqa.app")
start = (timezone.now() - timedelta(hours=2)).replace(second=0, microsecond=0)
o, _ = SessionOccurrence.objects.get_or_create(teacher=t, starts_at=start, defaults={"ends_at": start + timedelta(minutes=45)})
Booking.objects.get_or_create(occurrence=o, student=s, status="confirmed", defaults={"idempotency_key": f"past-{o.pk}"})
