"""Non-production demo data: one admin, two teachers, two students, one parent, schedules and tasks."""
import os
from datetime import date, time, timedelta

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from apps.accounts.models import GuardianLink, LinkStatus, Role, StudentProfile, TeacherAssignment, TeacherProfile, User
from apps.learning.models import Assignment, AssignmentStatus
from apps.scheduling.models import AvailabilityRule
from apps.scheduling.services import generate_occurrences

PEOPLE = [
    ("admin@halqa.app", "مدير المنصة", Role.ADMIN),
    ("teacher@halqa.app", "الشيخ عبدالرحمن السالم", Role.TEACHER),
    ("khalid@halqa.app", "الشيخ خالد العمري", Role.TEACHER),
    ("yousef@halqa.app", "يوسف أحمد", Role.STUDENT),
    ("sara@halqa.app", "سارة أحمد", Role.STUDENT),
    ("parent@halqa.app", "أحمد العلي", Role.PARENT),
]


class Command(BaseCommand):
    help = "Seed development/test data. Refuses to run in staging or production."

    def handle(self, *args, **opts):
        if settings.APP_ENV not in {"development", "test"}:
            raise CommandError("seed_dev only runs when APP_ENV is development or test.")
        password = os.environ.get("SEED_PASSWORD", "halqa123")  # dev-only shared password
        with transaction.atomic():
            u = {}
            for email, name, role in PEOPLE:
                user = User.objects.filter(email=email).first()
                if user is None:
                    user = User.objects.create_user(email, password, full_name=name, role=role,
                                                    is_staff=role == Role.ADMIN, is_superuser=role == Role.ADMIN)
                u[email] = user
            teacher, khalid = u["teacher@halqa.app"], u["khalid@halqa.app"]
            yousef, sara, parent = u["yousef@halqa.app"], u["sara@halqa.app"], u["parent@halqa.app"]
            TeacherProfile.objects.get_or_create(user=teacher, defaults=dict(
                specialization="حفظ وتجويد", levels="جميع المستويات", audience="الرجال والأطفال", tags=["hifz", "tajweed", "group"],
                offers_group=True, approved_at=timezone.now(),
                bio="مُجاز برواية حفص عن عاصم، يدرّس الحفظ والمراجعة منذ 12 عامًا، ويعتمد خططًا قصيرة منتظمة لتثبيت الحفظ."))
            TeacherProfile.objects.get_or_create(user=khalid, defaults=dict(
                specialization="تجويد متقدم", levels="متوسط ومتقدم", audience="الرجال", tags=["tajweed"], approved_at=timezone.now(),
                bio="يركّز على إتقان مخارج الحروف وصفاتها وتطبيق الأحكام أثناء التلاوة."))
            StudentProfile.objects.get_or_create(user=yousef, defaults={"level": "متوسط", "daily_goal": "5 أسطر يوميًا"})
            StudentProfile.objects.get_or_create(user=sara, defaults={"level": "مبتدئ", "daily_goal": "3 أسطر يوميًا"})
            for s in (yousef, sara):
                TeacherAssignment.objects.get_or_create(teacher=teacher, student=s, active=True)
                GuardianLink.objects.get_or_create(guardian=parent, student=s, status=LinkStatus.ACTIVE,
                                                   defaults={"approved_at": timezone.now(), "approved_by": u["admin@halqa.app"]})
            today = timezone.localdate()
            for t, hours in ((teacher, (time(16), time(21))), (khalid, (time(18, 30), time(21, 30)))):
                for wd in (6, 1, 3):  # Sunday, Tuesday, Thursday
                    AvailabilityRule.objects.get_or_create(teacher=t, weekday=wd, defaults=dict(
                        start_time=hours[0], end_time=hours[1], timezone="Africa/Cairo", session_minutes=45, buffer_minutes=15, valid_from=today))
            created = sum(generate_occurrences(t, start=today, days=21) for t in (teacher, khalid))
            if not Assignment.objects.filter(student=yousef).exists():
                due = timezone.now() + timedelta(hours=8)
                Assignment.objects.bulk_create([
                    Assignment(student=yousef, teacher=teacher, kind="hifz", title="حفظ سورة الملك", surah=67, ayah_from=1, ayah_to=10, due_at=due,
                               instructions="استمع إلى تلاوة الآيات ثلاث مرات قبل البدء، ثم احفظها على دفعتين (1–5 ثم 6–10)."),
                    Assignment(student=yousef, teacher=teacher, kind="review", title="مراجعة سورة النبأ", surah=78, ayah_from=1, ayah_to=40, due_at=due,
                               status=AssignmentStatus.IN_PROGRESS, instructions="راجع السورة كاملة مرتين، وركّز على مواضع التشابه."),
                    Assignment(student=yousef, teacher=teacher, kind="tajweed", title="تطبيق أحكام النون الساكنة والتنوين", surah=67, ayah_from=11,
                               ayah_to=20, due_at=due + timedelta(days=2), instructions="حدّد مواضع الإظهار والإخفاء ثم سجّل تلاوتك."),
                    Assignment(student=sara, teacher=teacher, kind="hifz", title="حفظ سورة الطارق", surah=86, ayah_from=1, ayah_to=10, due_at=due),
                ])
        self.stdout.write(self.style.SUCCESS(f"Seeded {len(PEOPLE)} accounts (password from SEED_PASSWORD), {created} new session slots."))
