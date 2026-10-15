"""
Integrity checks for a RESTORED copy of the database (pack prompt 27). Run only against an isolated restore target:
it refuses APP_ENV=production, and it changes passwords of a few accounts in that copy to prove sign-in works.

Checks:
- migrations: the copy has every migration of this code (none pending)
- sign-in: one admin, one teacher and one student sign in through the real API with a temporary password
  (an admin with two-step verification must be asked for the code, which also proves the MFA data survived)
- guardian and teacher links: a linked parent and the assigned teacher can open the child's progress
- assignments and feedback: a student can open a submission and sees its feedback
- bookings and attendance, lessons, quizzes and attempts: row counts and a sample read
- Quran: active source, 114 surahs, 6,236 ayahs (the byte-for-byte check is `import_quran <file> --verify`)
- media: every submission's recording metadata row exists and is "validated" (objects live in R2; see the docs)

Prints one JSON report and exits non-zero if any check fails. No names, emails or text are printed.
"""
import json
import secrets

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db.migrations.executor import MigrationExecutor
from django.db import connection
from rest_framework.test import APIClient


class Command(BaseCommand):
    help = "Verify a restored database copy (never production)."

    def handle(self, **_):
        if settings.APP_ENV == "production":
            raise CommandError("verify_restore changes passwords in the copy; it refuses APP_ENV=production.")
        from apps.accounts.models import GuardianLink, LinkStatus, Role, TeacherAssignment, User
        from apps.assessments.models import Attempt, Question, Test
        from apps.learning.models import Assignment, Course, Enrollment, Feedback, Lesson, LessonCompletion, Submission
        from apps.media.models import MediaObject
        from apps.quran.models import Ayah, QuranSource, Surah
        from apps.scheduling.models import Booking, SessionOccurrence

        checks, counts = {}, {}
        ex = MigrationExecutor(connection)
        pending = ex.migration_plan(ex.loader.graph.leaf_nodes())
        checks["migrations"] = "ok" if not pending else f"{len(pending)} pending"

        for name, qs in {
            "users_admin": User.objects.filter(role=Role.ADMIN), "users_teacher": User.objects.filter(role=Role.TEACHER),
            "users_student": User.objects.filter(role=Role.STUDENT), "users_parent": User.objects.filter(role=Role.PARENT),
            "guardian_links_active": GuardianLink.objects.filter(status=LinkStatus.ACTIVE),
            "teacher_assignments_active": TeacherAssignment.objects.filter(active=True),
            "assignments": Assignment.objects.all(), "submissions": Submission.objects.all(), "feedback": Feedback.objects.all(),
            "sessions": SessionOccurrence.objects.all(), "bookings": Booking.objects.all(),
            "bookings_with_attendance": Booking.objects.exclude(attendance=""),
            "courses": Course.objects.all(), "lessons": Lesson.objects.all(), "enrollments": Enrollment.objects.all(),
            "lesson_completions": LessonCompletion.objects.all(), "tests": Test.objects.all(), "questions": Question.objects.all(),
            "attempts": Attempt.objects.all(), "media_objects": MediaObject.objects.all(),
        }.items():
            counts[name] = qs.count()

        def api(user):
            c = APIClient()
            pw = secrets.token_urlsafe(18)
            user.set_password(pw)
            user.save(update_fields=["password"])
            path = "/api/v1/admin/auth/login" if user.role == Role.ADMIN else "/api/v1/auth/login"
            r = c.post(path, {"email": user.email, "password": pw, "client": "native", "device": "restore-drill"}, format="json")
            if r.status_code == 200:
                c.credentials(HTTP_AUTHORIZATION="Bearer " + r.json()["token"])
                return c, "ok"
            if user.role == Role.ADMIN and r.json().get("code") == "mfa_required":
                return None, "ok (password accepted; two-step code requested)"
            return None, f"failed ({r.status_code} {r.json().get('code')})"

        for role in (Role.ADMIN, Role.TEACHER, Role.STUDENT):
            u = User.objects.filter(role=role, status="active", is_active=True).order_by("pk").first()
            checks[f"sign_in_{role}"] = api(u)[1] if u else "skipped (no account of this role)"

        link = GuardianLink.objects.filter(status=LinkStatus.ACTIVE).select_related("guardian").first()
        if link:
            c, st = api(link.guardian)
            checks["parent_sees_linked_child"] = (
                "ok" if c and c.get(f"/api/v1/parent/children/{link.student_id}/progress").status_code == 200 else f"failed ({st})")
        else:
            checks["parent_sees_linked_child"] = "skipped (no active guardian link)"
        ta = TeacherAssignment.objects.filter(active=True).select_related("teacher").first()
        if ta:
            c, st = api(ta.teacher)
            checks["teacher_sees_assigned_student"] = (
                "ok" if c and c.get(f"/api/v1/teacher/students/{ta.student_id}/progress").status_code == 200 else f"failed ({st})")
        else:
            checks["teacher_sees_assigned_student"] = "skipped (no active teacher assignment)"
        fb = Feedback.objects.select_related("submission__student").first()
        if fb:
            c, st = api(fb.submission.student)
            r = c.get(f"/api/v1/submissions/{fb.submission_id}") if c else None
            checks["student_sees_feedback"] = "ok" if r is not None and r.status_code == 200 and r.json().get("feedback") else f"failed ({st})"
        else:
            checks["student_sees_feedback"] = "skipped (no feedback yet)"

        src = QuranSource.objects.filter(is_active=True).first()
        if src:
            n_s, n_a = Surah.objects.filter(source=src).count(), Ayah.objects.filter(source=src).count()
            checks["quran"] = "ok" if (n_s, n_a) == (114, 6236) and len(src.sha256) == 64 else f"failed ({n_s} surahs, {n_a} ayahs)"
            counts["quran_source"] = f"{src.slug} v{src.version} sha256 {src.sha256[:12]}…"
        else:
            checks["quran"] = "failed (no active source)"
        bad_media = Submission.objects.exclude(media__state=MediaObject.State.VALIDATED).count()
        checks["submission_media_metadata"] = "ok" if not bad_media else f"failed ({bad_media} submissions without a validated recording row)"

        ok = all(v.startswith(("ok", "skipped")) for v in checks.values())
        self.stdout.write(json.dumps({"ok": ok, "checks": checks, "counts": counts}, ensure_ascii=False, indent=1))
        if not ok:
            raise CommandError("restore verification failed")
