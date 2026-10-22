"""Turn an existing account into an administrator (the account keeps its password).
Used once, by the owner, from the Ops workflow; every change is printed."""
from django.contrib.sessions.models import Session
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from apps.accounts.models import AccountStatus, AuthToken, Role, User


class Command(BaseCommand):
    help = "Promote an existing account to admin: promote_admin --email you@example.com"

    def add_arguments(self, p):
        p.add_argument("--email", required=True)

    def handle(self, email, **_):
        email = email.strip().lower()
        user = User.objects.filter(email=email).first()
        if not user:
            raise CommandError(f"No account with {email}; nothing changed. Use create-admin for a new account.")
        if user.role == Role.ADMIN:
            self.stdout.write(f"{email} is already an admin; nothing changed.")
            return
        old = user.role
        user.role, user.is_staff, user.is_superuser, user.status = Role.ADMIN, True, True, AccountStatus.ACTIVE
        user.save(update_fields=["role", "is_staff", "is_superuser", "status"])
        from apps.accounts.admin_access import ensure_owner

        ensure_owner(user)  # the ops recovery path makes an owner
        # Sign the account out everywhere so no session keeps the old role.
        ended = 0
        for s in Session.objects.all().iterator():
            if str(s.get_decoded().get("_auth_user_id")) == str(user.pk):
                s.delete()
                ended += 1
        ended += AuthToken.objects.filter(user=user, revoked_at__isnull=True).update(revoked_at=timezone.now())
        self.stdout.write(self.style.SUCCESS(
            f"{email}: role {old} -> admin ({ended} session(s) signed out). Same password. "
            "Sign in at /#/admin and turn on two-step verification."))
