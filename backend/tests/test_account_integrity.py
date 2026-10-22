"""account_integrity (read-only): flags accounts whose state has no matching audit trail (22–23 Oct fix)."""
import json
from io import StringIO

import pytest
from django.core.management import call_command

from apps.accounts.models import AccountStatus, Role, User
from apps.core.audit import audit

from .conftest import make_user


@pytest.mark.django_db
def test_flags_self_promoted_and_self_reactivated_accounts_and_changes_nothing():
    legit_admin = make_user("owner-i@x.test", Role.ADMIN, is_staff=True)
    escalated = make_user("esc@x.test")
    audit("user.registered", actor=escalated, target=escalated)
    User.objects.filter(pk=escalated.pk).update(role=Role.ADMIN)  # what PATCH me allowed
    t = make_user("selfteach@x.test")
    audit("user.registered", actor=t, target=t)
    User.objects.filter(pk=t.pk).update(role=Role.TEACHER)
    back = make_user("back@x.test")
    audit("student.auto_suspended_absence", target=back, student=back.pk)
    mfa = make_user("mfa@x.test")
    User.objects.filter(pk=mfa.pk).update(mfa_enabled=True)
    ok = make_user("fine@x.test")
    audit("user.registered", actor=ok, target=ok)
    before = list(User.objects.order_by("pk").values_list("pk", "role", "status", "email"))
    out = StringIO()
    call_command("account_integrity", stdout=out)
    lines = [json.loads(x) for x in out.getvalue().splitlines()]
    flagged = {x["user"]: x["flags"] for x in lines if "flags" in x}
    assert flagged[escalated.pk] == ["admin_without_ops_or_invitation"]
    assert flagged[t.pk] == ["teacher_role_without_audit"]
    assert flagged[back.pk] == ["active_after_suspension_without_audit"]
    assert flagged[mfa.pk] == ["mfa_flag_without_setup"]
    assert legit_admin.pk not in flagged and ok.pk not in flagged
    assert lines[-1]["flagged"] == 4
    assert "@" not in out.getvalue()  # no email addresses
    assert list(User.objects.order_by("pk").values_list("pk", "role", "status", "email")) == before
    assert AccountStatus.ACTIVE == User.objects.get(pk=back.pk).status
