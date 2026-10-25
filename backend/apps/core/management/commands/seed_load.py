"""
Synthetic dataset for load tests (pack prompt 25). Never for production: it refuses unless APP_ENV is not
production AND LOAD_TEST_DATASET=1 is set, so a mistyped DATABASE_URL cannot fill the live database.

Default profile: 500 students, 10 teachers (50 students each), 250 parents (one child each), 6 tasks per student,
3 published courses, 1 published quiz, two weeks of 45-minute slots per teacher, and one 1-seat "race" slot.
Every account shares one password (LOAD_TEST_PASSWORD) so the load script can sign in as any of them.
"""
import os
from datetime import datetime, time, timedelta

from django.conf import settings
from django.contrib.auth.hashers import make_password
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from apps.accounts.models import GuardianLink, LinkStatus, Role, StudentProfile, TeacherAssignment, TeacherProfile, User
from apps.assessments.models import Question, Test
from apps.learning.models import Assignment, AssignmentStatus, Course, Lesson
from apps.scheduling.models import AvailabilityRule, SessionOccurrence

KINDS = ["hifz", "review", "tajweed"]


class Command(BaseCommand):
    help = "Create the synthetic load-test dataset (refuses in production)."

    def add_arguments(self, parser):
        parser.add_argument("--students", type=int, default=500)
        parser.add_argument("--teachers", type=int, default=10)
        parser.add_argument("--refresh", action="store_true",
                            help="Dataset already there (a staging re-run): add the next two weeks of slots and a new race slot.")

    def handle(self, *args, **o):
        if settings.APP_ENV == "production" or os.environ.get("LOAD_TEST_DATASET") != "1":
            raise CommandError("seed_load needs LOAD_TEST_DATASET=1 and a non-production APP_ENV.")
        if User.objects.filter(email__startswith="load-").exists():
            if o["refresh"]:
                return self.refresh()
            raise CommandError("The load-test dataset already exists in this database.")
        pw = make_password(os.environ.get("LOAD_TEST_PASSWORD", "load-test-only-1"))  # hashed once, shared
        now, today = timezone.now(), timezone.localdate()
        with transaction.atomic():
            teachers = User.objects.bulk_create([
                User(email=f"load-t{i:02d}@example.test", full_name=f"معلم تجريبي {i}", role=Role.TEACHER, gender="female" if i % 2 else "male", password=pw)
                for i in range(o["teachers"])])
            TeacherProfile.objects.bulk_create([TeacherProfile(user=t, specialization="حفظ وتجويد", approved_at=now, offers_group=True)
                                                for t in teachers])
            students = User.objects.bulk_create([
                User(email=f"load-s{i:04d}@example.test", full_name=f"طالب تجريبي {i}", role=Role.STUDENT, password=pw)
                for i in range(o["students"])])
            StudentProfile.objects.bulk_create([StudentProfile(user=s, level="متوسط", daily_goal="5 أسطر") for s in students])
            parents = User.objects.bulk_create([
                User(email=f"load-p{i:04d}@example.test", full_name=f"ولي أمر تجريبي {i}", role=Role.PARENT, password=pw)
                for i in range(len(students) // 2)])
            per = max(1, len(students) // len(teachers))
            TeacherAssignment.objects.bulk_create([TeacherAssignment(teacher=teachers[min(i // per, len(teachers) - 1)], student=s)
                                                   for i, s in enumerate(students)])
            GuardianLink.objects.bulk_create([GuardianLink(guardian=p, student=students[i * 2], status=LinkStatus.ACTIVE, approved_at=now)
                                              for i, p in enumerate(parents)])
            tasks = []
            for i, s in enumerate(students):
                t = teachers[min(i // per, len(teachers) - 1)]
                for k in range(6):
                    tasks.append(Assignment(student=s, teacher=t, kind=KINDS[k % 3], title=f"مهمة {k + 1}", surah=67 + k, ayah_from=1,
                                            ayah_to=10, due_at=now + timedelta(days=k - 2),
                                            status=AssignmentStatus.IN_PROGRESS if k % 2 else AssignmentStatus.NOT_STARTED))
            Assignment.objects.bulk_create(tasks, batch_size=1000)
            for c in range(3):
                course = Course.objects.create(title=f"دورة تجريبية {c + 1}", topic="tajweed", teacher=teachers[0], state="published")
                Lesson.objects.bulk_create([Lesson(course=course, order=n, title=f"درس {n}", kind="text", body="نص تجريبي.",
                                                   duration_minutes=10, state="published") for n in range(1, 6)])
            quiz = Test.objects.create(title="اختبار تجريبي", topic="tajweed", author=teachers[0], state="published", duration_minutes=10,
                                       max_attempts=50)
            Question.objects.bulk_create([Question(test=quiz, order=n, kind="mcq", prompt=f"سؤال {n}", options=["أ", "ب", "ج"], answer_key=0)
                                          for n in range(1, 6)])
            for t in teachers:
                for wd in range(7):
                    AvailabilityRule.objects.create(teacher=t, weekday=wd, start_time=time(8), end_time=time(22), timezone="Africa/Cairo",
                                                    session_minutes=45, buffer_minutes=15, valid_from=today)
        slots = AvailabilityRule.objects.filter(teacher__in=teachers).count()  # bookable times are computed
        race = self.race_slot(teachers[-1], today)
        self.stdout.write(f"students={len(students)} teachers={len(teachers)} parents={len(parents)} tasks={len(tasks)} "
                          f"slots={slots} race_occurrence={race.pk} race_teacher={teachers[-1].pk} quiz={quiz.pk}")

    @staticmethod
    def race_slot(teacher, today):
        """One extra 1-seat slot for the booking race: inside the booking window, at 23:00 Cairo time (after the regular
        08:00–22:00 slots) so teacher and student overlap rules cannot interfere. A re-run takes the next free night."""
        from zoneinfo import ZoneInfo

        for d in range(3, 14):
            start = datetime.combine(today + timedelta(days=d), time(23), ZoneInfo("Africa/Cairo"))
            if not SessionOccurrence.objects.filter(teacher=teacher, starts_at=start).exists():
                return SessionOccurrence.objects.create(teacher=teacher, starts_at=start, ends_at=start + timedelta(minutes=45), capacity=1)
        raise CommandError("No free night for a race slot in the next two weeks.")

    def refresh(self):
        teachers = list(User.objects.filter(email__startswith="load-t", role=Role.TEACHER).order_by("email"))
        today = timezone.localdate()
        slots = AvailabilityRule.objects.filter(teacher__in=teachers).count()  # bookable times are computed
        race = self.race_slot(teachers[-1], today)
        self.stdout.write(f"refreshed: students={User.objects.filter(email__startswith='load-s').count()} teachers={len(teachers)} "
                          f"new_slots={slots} race_occurrence={race.pk} race_teacher={teachers[-1].pk}")
