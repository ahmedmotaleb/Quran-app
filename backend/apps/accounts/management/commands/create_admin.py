"""Create the first administrator. The password comes from the ADMIN_PASSWORD environment variable
(never a command-line argument, so it is not stored in shell history or CI logs)."""
import os

from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError

from apps.accounts.models import User


class Command(BaseCommand):
    help = "Create an admin account: create_admin --email you@example.com (password from $ADMIN_PASSWORD)."

    def add_arguments(self, p):
        p.add_argument("--email", required=True)
        p.add_argument("--name", default="مدير المنصة")

    def handle(self, email, name, **_):
        password = os.environ.get("ADMIN_PASSWORD", "")
        email = email.strip().lower()
        if User.objects.filter(email=email).exists():
            raise CommandError(f"{email} already exists; nothing changed.")
        try:
            validate_password(password)
        except ValidationError as e:
            raise CommandError("ADMIN_PASSWORD rejected: " + " ".join(e.messages)) from None
        User.objects.create_superuser(email, password, full_name=name)
        self.stdout.write(self.style.SUCCESS(f"Admin {email} created. Sign in at /#/admin and turn on two-step verification."))
