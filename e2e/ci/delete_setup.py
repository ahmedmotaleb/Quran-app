# account-delete.mjs: the seeded admin gets a known authenticator secret (two-step verification on, as in production),
# and one student with no activity is created (the "removed completely" path).
from apps.accounts.models import Role, StudentProfile, User

User.objects.filter(email="admin@halqa.app").update(mfa_enabled=True, mfa_secret="JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP")
u, _ = User.objects.get_or_create(email="e2e-fresh@example.com", defaults={"full_name": "طالب بلا نشاط", "role": Role.STUDENT})
u.set_password("halqa123"); u.save()
StudentProfile.objects.get_or_create(user=u)
