# Turn two-step verification off again for the seeded admin (admin.mjs turns it on).
from apps.accounts.models import User
User.objects.filter(email="admin@halqa.app").update(mfa_enabled=False, mfa_secret="")
