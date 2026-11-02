# A new teacher waiting for approval (no Riwayat chosen yet), able to sign in: qtest@halqa.app / halqa123.
from apps.accounts.models import Role, TeacherProfile, User
u = User.objects.filter(email="qtest@halqa.app").first() or User.objects.create_user("qtest@halqa.app", "halqa123", full_name="أحمد محمد", role=Role.TEACHER, gender="male")
TeacherProfile.objects.get_or_create(user=u)
