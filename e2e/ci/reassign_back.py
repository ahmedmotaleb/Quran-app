# Moves يوسف back to عبدالرحمن through the same service the admin API uses (the e2e checks the app's own polling).
from apps.accounts.models import User
from apps.accounts.reassign import assign_teacher

assign_teacher(User.objects.get(email="yousef@halqa.app"), User.objects.select_related("teacher_profile").get(email="teacher@halqa.app"),
               User.objects.get(email="admin@halqa.app"), source="e2e")
