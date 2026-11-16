# The first upcoming session of teacher@halqa.app's weekly series started 10 minutes ago (attendance and evaluation open).
from datetime import timedelta
from django.utils import timezone
from apps.scheduling.models import SessionOccurrence
o = SessionOccurrence.objects.filter(series__teacher__email="teacher@halqa.app", status="scheduled").order_by("starts_at").first()
start = (timezone.now() - timedelta(minutes=10)).replace(second=0, microsecond=0)
SessionOccurrence.objects.filter(pk=o.pk).update(starts_at=start, ends_at=start + (o.ends_at - o.starts_at))
