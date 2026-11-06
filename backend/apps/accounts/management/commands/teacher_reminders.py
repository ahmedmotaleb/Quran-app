"""«اختر معلمك» reminder for students without a teacher (every AppSettings.teacher_reminder_hours; run hourly)."""
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Remind students without a teacher to choose one (safe to repeat)."

    def handle(self, **_):
        from apps.accounts.teacher_requests import send_reminders

        self.stdout.write(self.style.SUCCESS(f"Teacher reminders: {send_reminders()}"))
