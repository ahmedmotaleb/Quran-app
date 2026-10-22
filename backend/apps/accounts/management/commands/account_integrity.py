"""Read-only check, run once after the 22–23 October profile-update fix (`PATCH me` accepted role, status, email and
mfa_enabled for about a day). Lists accounts whose current state has no matching audit trail, so the owner can review
them. It changes nothing and prints no email addresses or names: ids, roles, dates and the reason for each flag.

  python manage.py account_integrity
"""
import json
import logging
from collections import defaultdict

from django.core.management.base import BaseCommand

from apps.accounts.models import AccountStatus, AdminProfile, Role, User
from apps.core.models import AuditEvent

log = logging.getLogger("halqa.ops")

STATUS_ACTIONS = {"admin.user_status", "student.auto_suspended_absence", "admin.suspended", "admin.reactivated",
                  "admin.bulk_activate", "admin.bulk_suspend", "admin.bulk_archive"}


class Command(BaseCommand):
    help = "Flag accounts whose role, status or two-step verification has no matching audit event (read-only)."

    def handle(self, **_):
        ev = defaultdict(list)  # user id -> [(created_at, action, data)]
        for a in AuditEvent.objects.filter(target_type="accounts.user").values("target_id", "action", "data", "created_at").iterator():
            ev[a["target_id"]].append((a["created_at"], a["action"], a["data"] or {}))
        for a in AuditEvent.objects.filter(action__startswith="admin.bulk_").values("action", "data", "created_at").iterator():
            for pk in (a["data"] or {}).get("ids") or []:
                ev[str(pk)].append((a["created_at"], a["action"], a["data"] or {}))
        accepted = {str(a) for a in AuditEvent.objects.filter(action="invitation.accepted").values_list("actor_id", flat=True)}
        profiles = {p.user_id: p for p in AdminProfile.objects.all()}
        flags = []
        for u in User.objects.exclude(status=AccountStatus.DELETED).iterator():
            k, why = str(u.pk), []
            acts = {x[1] for x in ev[k]}
            created_role = next((x[2].get("role") for x in ev[k] if x[1] == "admin.user_created"), None)
            if u.role == Role.ADMIN:
                p = profiles.get(u.pk)
                if not (u.is_staff or u.is_superuser or (p and p.created_by_id)):
                    why.append("admin_without_ops_or_invitation")
            elif u.role != Role.STUDENT:
                legit = ("admin.user_promoted_to_teacher" in acts or k in accepted or "admin.bulk_make_teacher" in acts
                         or (created_role == u.role))
                if ("user.registered" in acts or created_role) and not legit:
                    why.append(f"{u.role}_role_without_audit")
            elif created_role and created_role != u.role:
                why.append("role_differs_from_creation")
            if u.mfa_enabled and "auth.mfa_enabled" not in acts:
                why.append("mfa_flag_without_setup")
            st = [x for x in sorted(ev[k], key=lambda x: x[0]) if x[1] in STATUS_ACTIONS]
            if st and u.status == AccountStatus.ACTIVE:
                last = st[-1]
                ended = (last[1] in ("student.auto_suspended_absence", "admin.suspended", "admin.bulk_suspend", "admin.bulk_archive")
                         or (last[1] == "admin.user_status" and last[2].get("new") in ("suspended", "archived")))
                if ended:
                    why.append("active_after_suspension_without_audit")
            if why:
                flags.append({"user": u.pk, "role": u.role, "status": u.status, "joined": u.date_joined.date().isoformat(),
                              "last_login": u.last_login.isoformat()[:16] if u.last_login else None, "flags": why})
        for f in flags:
            log.warning("account_integrity_flag", extra=f)
            self.stdout.write(json.dumps(f))
        summary = {"accounts": User.objects.count(), "flagged": len(flags), "phones": User.objects.exclude(phone="").count()}
        log.warning("account_integrity_summary", extra=summary)
        self.stdout.write(json.dumps(summary))
