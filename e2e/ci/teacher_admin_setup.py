# teacher-admin.mjs: the seeded owner and the seeded teacher both have two-step verification on with known secrets
# (as in production; the teacher's existing authenticator is reused for the admin portal).
from apps.accounts.models import User

User.objects.filter(email="admin@halqa.app").update(mfa_enabled=True, mfa_secret="JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP")
User.objects.filter(email="teacher@halqa.app").update(mfa_enabled=True, mfa_secret="KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU")
