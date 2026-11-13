# An adhkar reminder in Yousef's notifications (as the hourly job sends it) for the first approved entry; prints nothing.
from apps.accounts.models import User
from apps.adhkar import services
from apps.adhkar.models import Dhikr
d = Dhikr.objects.filter(status="approved", enabled=True).order_by("pk").first()
n = services.send(User.objects.get(email="yousef@halqa.app"), d, "e2e:tap")
open("/tmp/adhkar-note-id", "w").write(str(n.pk))
