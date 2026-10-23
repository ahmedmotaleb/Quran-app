# A published circle of teacher@halqa.app with Yousef and Sara as active members (both linked to the teacher).
from apps.accounts.models import User
from apps.scheduling.models import Circle, CircleMember
t = User.objects.get(email="teacher@halqa.app")
c, _ = Circle.objects.get_or_create(name="حلقة الفجر", teacher=t, defaults={"capacity": 10, "state": "published"})
for e in ("yousef@halqa.app", "sara@halqa.app"):
    CircleMember.objects.get_or_create(circle=c, student=User.objects.get(email=e), active=True)
