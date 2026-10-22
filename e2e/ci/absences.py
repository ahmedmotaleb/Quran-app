# Two earlier unexcused absences for Sara (marked directly, as history) and one session that took place a few hours
# ago, not marked yet: the teacher's «غائب» on it is the third unexcused absence (e2e/excuses.mjs).
# Each session takes the nearest free time for the teacher (the seed already has sessions).
from datetime import timedelta
from django.db import IntegrityError, transaction
from django.utils import timezone
from apps.accounts.models import User
from apps.scheduling.models import Booking, SessionOccurrence
t = User.objects.get(email="teacher@halqa.app"); s = User.objects.get(email="sara@halqa.app")
now = timezone.now().replace(second=0, microsecond=0)
for i, (ago, att) in enumerate([(timedelta(days=3), "absent"), (timedelta(days=2), "absent"), (timedelta(hours=2), "")]):
    for extra in range(0, 24 * 60, 50):
        start = now - ago - timedelta(minutes=extra)
        try:
            with transaction.atomic():
                o = SessionOccurrence.objects.create(teacher=t, starts_at=start, ends_at=start + timedelta(minutes=45), capacity=1)
            break
        except IntegrityError:
            continue
    Booking.objects.create(occurrence=o, student=s, idempotency_key=f"e2e-abs-{i}", attendance=att)
