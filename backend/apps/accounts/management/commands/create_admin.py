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
        existing = User.objects.filter(email=email).first()
        if existing:
            raise CommandError(f"{email} already exists (role {existing.role}, active={existing.is_active}, "
                               f"joined {existing.date_joined:%Y-%m-%d %H:%M} UTC); nothing changed.")
        try:
            validate_password(password)
        except ValidationError as e:
            raise CommandError("ADMIN_PASSWORD rejected: " + " ".join(e.messages)) from None
        from apps.accounts.admin_access import ensure_owner

        ensure_owner(User.objects.create_superuser(email, password, full_name=name))  # the first admin is an owner
        self.stdout.write(self.style.SUCCESS(f"Admin {email} created. Sign in at /#/admin and turn on two-step verification."))
