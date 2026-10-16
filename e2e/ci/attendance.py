# Mark Yousef's past bookings present (the parent view then shows real attendance).
from django.utils import timezone
from apps.scheduling.models import Booking
Booking.objects.filter(student__email="yousef@halqa.app", occurrence__starts_at__lt=timezone.now()).update(attendance="present")
