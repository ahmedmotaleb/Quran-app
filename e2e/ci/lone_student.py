# Two students with no teacher, able to sign in (lone@halqa.app, lone2@halqa.app / halqa123), for «اختر معلمك».
from apps.accounts.models import Role, StudentProfile, User
for email, name in (("lone@halqa.app", "طالب بلا معلم"), ("lone2@halqa.app", "طالب ثان بلا معلم")):
    u = User.objects.filter(email=email).first() or User.objects.create_user(email, "halqa123", full_name=name, role=Role.STUDENT, gender="male")
    StudentProfile.objects.get_or_create(user=u, defaults={"level": "مبتدئ", "daily_goal": "5 أسطر"})
