# A daily reading reminder in Yousef's inbox (as the hourly job creates it), to check tapping it opens the Mushaf.
from apps.accounts.models import User
from apps.notifications.services import notify
notify(User.objects.get(email="yousef@halqa.app"), "reminder_reading", "وردك اليومي", "حان وقت وردك من القرآن الكريم.",
       link="/mushaf", dedupe="reminder:reading:e2e", data={"screen": "mushaf"})
