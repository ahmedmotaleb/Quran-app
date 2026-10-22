"""Convert open teacher invitations (previous flow) into teacher accounts with a password-setup email.

  python manage.py migrate_teacher_invitations          # dry run: prints what would happen
  python manage.py migrate_teacher_invitations --apply  # creates accounts, revokes the invitations, sends the emails
"""
import json
import logging

from django.core.management.base import BaseCommand

from apps.accounts.teacher_onboarding import migrate_open_invitations

log = logging.getLogger("halqa.ops")


class Command(BaseCommand):
    help = "Open teacher_account invitations → teacher accounts + setup email (dry run unless --apply)."

    def add_arguments(self, p):
        p.add_argument("--apply", action="store_true")

    def handle(self, apply=False, **_):
        def out(line):
            self.stdout.write(line)
            log.warning("teacher_invitation_migration", extra={"line": line[:300], "apply": apply})

        stats = migrate_open_invitations(apply, out)
        log.warning("teacher_invitation_migration_summary", extra={**stats, "apply": apply})
        self.stdout.write(json.dumps({**stats, "apply": apply}))
