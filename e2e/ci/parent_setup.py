# A new parent created as the admin would (no password yet), linked to Yousef and Sara; the one-time setup link's
# query is written to $SETUP_OUT for e2e/parent-login.mjs.
import os
from django.utils import timezone
from apps.accounts.models import AccountStatus, GuardianLink, LinkStatus, Role, User
from apps.accounts.views import password_link
admin = User.objects.get(email="admin@halqa.app")
p, _ = User.objects.get_or_create(email="new.parent@halqa.app", defaults={"full_name": "خالد الوالد", "role": Role.PARENT, "status": AccountStatus.ACTIVE})
p.set_unusable_password(); p.save()
for e in ("yousef@halqa.app", "sara@halqa.app"):
    GuardianLink.objects.get_or_create(guardian=p, student=User.objects.get(email=e),
                                       defaults={"status": LinkStatus.ACTIVE, "approved_at": timezone.now(), "approved_by": admin, "created_by": admin})
open(os.environ["SETUP_OUT"], "w").write(password_link(p).split("?", 1)[1])
