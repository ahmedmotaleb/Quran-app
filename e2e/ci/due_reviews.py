# Make every spaced-repetition schedule due today (the reviews suite then sees generated review tasks).
from apps.learning.models import ReviewSchedule
from apps.learning.reviews import _today
for s in ReviewSchedule.objects.select_related("student"):
    ReviewSchedule.objects.filter(pk=s.pk).update(next_due=_today(s.student))
