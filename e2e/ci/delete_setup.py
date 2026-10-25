# account-delete.mjs: the seeded admin gets a known authenticator secret (two-step verification on, as in production),
# and one student with no activity is created (the "removed completely" path).
from apps.accounts.models import Role, StudentProfile, User

User.objects.filter(email="admin@halqa.app").update(mfa_enabled=True, mfa_secret="JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP")
u, _ = User.objects.get_or_create(email="e2e-fresh@example.com", defaults={"full_name": "طالب بلا نشاط", "role": Role.STUDENT})
u.set_password("halqa123"); u.save()
StudentProfile.objects.get_or_create(user=u)

# The teacher has upcoming sessions (bookable times are computed now, so none exist until someone books): one booked
# by Yousef and one session the teacher opened.
from datetime import timedelta
from django.utils import timezone
from apps.scheduling import services
from apps.scheduling.models import SessionOccurrence

t = User.objects.get(email="teacher@halqa.app")
start = (timezone.now() + timedelta(days=3)).replace(minute=0, second=0, microsecond=0)
for i, h in enumerate((0, 3)):
    o = SessionOccurrence.objects.create(teacher=t, starts_at=start + timedelta(hours=h), ends_at=start + timedelta(hours=h, minutes=45))
    if i == 0:
        services.book(student=User.objects.get(email="yousef@halqa.app"), occurrence_id=o.pk, idempotency_key="e2e-delete-upcoming")
