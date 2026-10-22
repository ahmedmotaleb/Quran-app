"""Non-production demo data: one admin, two teachers, two students, one parent, schedules and tasks."""
import os
from datetime import date, time, timedelta

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from apps.accounts.models import GuardianLink, LinkStatus, Role, StudentProfile, TeacherAssignment, TeacherProfile, User
from apps.assessments.models import Question, Test
from apps.learning.models import Assignment, AssignmentStatus, Course, Lesson
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
                if role == Role.ADMIN:
                    from apps.accounts.admin_access import ensure_owner

                    ensure_owner(user)
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
            # Library + quiz (development content: titles from the design; lesson bodies are placeholders).
            if not Course.objects.exists():
                placeholder = "محتوى تجريبي لبيئة التطوير. يضيف المعلم نص الدرس ومواده قبل النشر."
                for topic, level, title, lessons in (
                    ("tajweed", "مبتدئ", "أساسيات التجويد", [("مقدمة في أحكام النون الساكنة والتنوين", 14), ("الإظهار الحلقي: أمثلة تطبيقية", 11), ("المدود وأنواعها", 22)]),
                    ("adab", "", "آداب التلاوة", [("آداب حامل القرآن", 18)]),
                    ("hifz", "", "الحفظ والمراجعة", [("كيف تراجع حفظك بانتظام", 16)]),
                ):
                    c = Course.objects.create(title=title, topic=topic, level=level, teacher=teacher, state="published")
                    for i, (lt, mins) in enumerate(lessons, 1):
                        Lesson.objects.create(course=c, order=i, title=lt, kind="text", body=placeholder, duration_minutes=mins, state="published")
            if not Test.objects.exists():
                t = Test.objects.create(title="اختبار أحكام النون الساكنة والتنوين", topic="tajweed", author=teacher, state="published",
                                        duration_minutes=10, max_attempts=2)
                for i, (prompt, options, key) in enumerate((
                    ("كم عدد حروف الإظهار الحلقي؟", ["4", "6", "15", "1"], 1),
                    ("ما الحكم عند مجيء الباء بعد النون الساكنة أو التنوين؟", ["الإخفاء", "الإدغام", "الإقلاب", "الإظهار"], 2),
                    ("كم عدد حروف الإخفاء الحقيقي؟", ["15", "6", "4", "10"], 0),
                    ("حروف الإدغام مجموعة في كلمة:", ["يرملون", "ينمو", "قطب جد", "أخي هاك"], 0),
                ), 1):
                    Question.objects.create(test=t, order=i, kind="mcq", prompt=prompt, options=options, answer_key=key)
                Question.objects.create(test=t, order=5, kind="recitation", points=2,
                                        prompt="سجّل تلاوتك لموضع من سورة الملك يجتمع فيه حكما الإظهار والإخفاء.")
        self.stdout.write(self.style.SUCCESS(f"Seeded {len(PEOPLE)} accounts (password from SEED_PASSWORD), {created} new session slots."))
