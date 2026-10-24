# google-sessions.mjs: move the teacher's Google-backed session to start in 5 minutes (join window open). Only the
# time in HALQA changes here; the browser test checks the join behaviour, not Google.
from datetime import timedelta
from django.utils import timezone
from apps.scheduling.models import SessionOccurrence
o = SessionOccurrence.objects.filter(google_event__isnull=False, status="scheduled").latest("id")
start = (timezone.now() + timedelta(minutes=5)).replace(second=0, microsecond=0)
end = start + timedelta(minutes=45)
SessionOccurrence.objects.filter(teacher=o.teacher, starts_at__lt=end, ends_at__gt=start, status="scheduled").exclude(pk=o.pk).exclude(bookings__status="confirmed").update(status="cancelled")
SessionOccurrence.objects.filter(pk=o.pk).update(starts_at=start, ends_at=end)
