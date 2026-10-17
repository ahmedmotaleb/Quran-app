# 30 test students named "طالب تجريبي NN" (26 active, 4 suspended) for the admin bulk-action suite.
from apps.accounts.models import AccountStatus, Role, StudentProfile, User
for i in range(30):
    u, made = User.objects.get_or_create(email=f"bulk{i:02d}@halqa.test", defaults={"full_name": f"طالب تجريبي {i:02d}", "role": Role.STUDENT})
    if made:
        StudentProfile.objects.create(user=u)
    u.status = AccountStatus.SUSPENDED if i >= 26 else AccountStatus.ACTIVE
    u.save(update_fields=["status"])
