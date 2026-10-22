"""«الإدارة والصلاحيات»: invite admins by email, change their access, suspend/reactivate them (admin_access.py).

Rules, all checked on the server inside one transaction:
- Requires `admins.manage`, and a current authenticator code for every change (fresh MFA).
- Nobody changes their own access or status here.
- Only an owner creates, edits, suspends or reactivates an owner, and only an owner grants the owner level.
- An admin can only grant permissions they hold themselves.
- There is always at least one active owner (row locks on the owners make concurrent changes safe).
- Audit: admin.invited / setup_completed / permission_changed / preset_changed / suspended / reactivated, with
  the permissions added and removed. Never the password, the TOTP secret or the setup code.
"""
from __future__ import annotations

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.audit import audit
from apps.core.exceptions import ApiError

from . import admin_access as aa
from .models import AccountStatus, AdminProfile, AuthToken, Invitation, Role, User
from .permissions import IsAdminRole

INVITE_DAYS = 3


def _mask_phone(p: str) -> str:
    p = (p or "").strip()
    return p[:4] + "•" * max(0, len(p) - 6) + p[-2:] if len(p) > 6 else ("•" * len(p))


def admin_out(u: User, viewer) -> dict:
    prof = getattr(u, "admin_profile", None)
    return {"id": u.pk, "full_name": u.full_name, "email": u.email,
            "phone": u.phone if aa.has(viewer, "users.view_contact") else _mask_phone(u.phone),
            "status": u.status, "mfa_enabled": u.mfa_enabled, "last_login": u.last_login.isoformat() if u.last_login else None,
            "level": prof.access_level if prof else "", "preset": prof.preset if prof else "",
            "preset_label": aa.PRESET_LABELS.get(prof.preset, "") if prof else "",
            "permissions": sorted(aa.perms_of(u)), "is_self": u.pk == viewer.pk}


def _resolve(level: str, preset: str, perms) -> tuple[str, str, list[str]]:
    if level not in ("owner", "admin"):
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"level": ["مستوى غير صالح."]})
    if level == "owner":
        return "owner", "owner", []
    if preset == "owner":
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"preset": ["اختر مستوى «المالك» لصلاحيات المالك."]})
    if preset in aa.PRESETS:
        return "admin", preset, sorted(aa.PRESETS[preset])
    if preset != "custom":
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"preset": ["اختر مجموعة صلاحيات."]})
    chosen = aa.validate(perms or [])
    if not chosen:
        raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"permissions": ["اختر صلاحية واحدة على الأقل."]})
    return "admin", "custom", sorted(chosen)


def _may_grant(actor, level: str, perms: list[str]) -> None:
    if level == "owner" and not aa.is_owner(actor):
        raise ApiError("owner_only", "منح صلاحيات المالك متاح للمالك فقط.", 403)
    beyond = sorted(set(perms) - aa.perms_of(actor))
    if beyond:
        raise ApiError("cannot_grant", "لا يمكنك منح صلاحيات لا تملكها.", 403, {"permissions": beyond})


def _active_owners(exclude_pk: int | None = None):
    qs = (AdminProfile.objects.select_for_update().filter(access_level="owner", user__status=AccountStatus.ACTIVE,
                                                          user__is_active=True))
    return [p for p in qs if p.user_id != exclude_pk]


def _target(actor, pk: int) -> User:
    u = User.objects.select_for_update(of=("self",)).filter(pk=pk, role=Role.ADMIN).select_related("admin_profile").first()
    if u is None:
        raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
    if u.pk == actor.pk:
        raise ApiError("self_change", "لا يمكنك تغيير صلاحياتك أو حالتك بنفسك. اطلب ذلك من مالك آخر.", 403)
    if aa.is_owner(u) and not aa.is_owner(actor):
        raise ApiError("owner_only", "إدارة حسابات المالكين متاحة للمالك فقط.", 403)
    return u


class AdminAccounts(APIView):
    """GET: every admin (and open admin invitations). POST: invite an admin by email (setup link emailed)."""

    permission_classes = [IsAdminRole]
    admin_perm = "admins.manage"

    def get(self, request):
        admins = User.objects.filter(role=Role.ADMIN).exclude(status=AccountStatus.DELETED).select_related("admin_profile").order_by("date_joined")
        invites = [i for i in Invitation.objects.filter(purpose=Invitation.Purpose.ADMIN_ACCOUNT).exclude(revoke_reason="replaced")
                   .select_related("created_by").order_by("-created_at")[:50] if i.status in ("pending", "failed", "expired")]
        from .invitations import invitation_out

        return Response({"results": [admin_out(u, request.user) for u in admins],
                         "invitations": [{**invitation_out(i), "level": i.admin_level, "preset": i.admin_preset} for i in invites],
                         "permissions": aa.PERMISSIONS, "presets": {k: sorted(v) for k, v in aa.PRESETS.items()},
                         "preset_labels": aa.PRESET_LABELS})

    def post(self, request):
        from .invitations import _domain, _link, _send

        aa.require_fresh_mfa(request)
        d = request.data
        name, email = str(d.get("full_name", "")).strip(), str(d.get("email", "")).strip().lower()
        if len(name) < 2 or "@" not in email or "." not in email.split("@")[-1]:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"email": ["اكتب البريد الإلكتروني."], "full_name": ["اكتب الاسم."]})
        level, preset, perms = _resolve(str(d.get("level", "admin")), str(d.get("preset", "")), d.get("permissions"))
        _may_grant(request.user, level, perms)
        if User.objects.filter(email__iexact=email).exists():
            raise ApiError("email_taken", "لهذا البريد حساب في حَلْقة بالفعل. استخدم بريدًا آخر لحساب المسؤول.", 409, {"email": ["بريد مسجّل."]})
        with transaction.atomic():
            Invitation.objects.filter(purpose=Invitation.Purpose.ADMIN_ACCOUNT, email=email, revoked_at__isnull=True, uses=0).update(
                revoked_at=timezone.now(), revoke_reason="replaced")
            inv, raw = Invitation.issue(purpose=Invitation.Purpose.ADMIN_ACCOUNT, created_by=request.user, days=INVITE_DAYS,
                                        email=email, admin_level=level, admin_preset=preset, admin_permissions=perms)
            audit("admin.invited", actor=request.user, target=inv, request=request, level=level, preset=preset,
                  permissions=perms, to_domain=_domain(email))
        sent = _send(inv, raw, request.user, request, "create")
        return Response({"id": inv.pk, "email_sent": sent, "status": inv.status, "expires_at": inv.expires_at.isoformat(),
                         "name": name, "link_sent_to": email}, status=201)


class AdminAccountDetail(APIView):
    """PATCH {level, preset, permissions}: change an admin's access (fresh MFA). Applies on the next request."""

    permission_classes = [IsAdminRole]
    admin_perm = "admins.manage"

    def patch(self, request, pk):
        aa.require_fresh_mfa(request)
        d = request.data
        with transaction.atomic():
            u = _target(request.user, pk)
            prof, _ = AdminProfile.objects.select_for_update().get_or_create(user=u)
            level, preset, perms = _resolve(str(d.get("level", prof.access_level)), str(d.get("preset", "")), d.get("permissions"))
            _may_grant(request.user, level, perms)
            if prof.access_level == "owner" and level != "owner" and not _active_owners(exclude_pk=u.pk):
                raise ApiError("last_owner", "يجب أن يبقى مالك نشط واحد على الأقل.", 409)
            before, before_level, before_preset = set(aa.perms_of(u)), prof.access_level, prof.preset
            prof.access_level, prof.preset, prof.permissions = level, preset, perms
            prof.save()
            after = set(aa.ALL if level == "owner" else perms)
            if before_preset != preset or before_level != level:
                audit("admin.preset_changed", actor=request.user, target=u, request=request, old_level=before_level, new_level=level,
                      old_preset=before_preset, new_preset=preset)
            audit("admin.permission_changed", actor=request.user, target=u, request=request,
                  added=sorted(after - before), removed=sorted(before - after))
        u.refresh_from_db()
        return Response(admin_out(u, request.user))


class AdminAccountStatus(APIView):
    """POST {status: suspended|active, reason}: suspend or reactivate an admin (fresh MFA; never the last owner)."""

    permission_classes = [IsAdminRole]
    admin_perm = "admins.manage"

    def post(self, request, pk):
        aa.require_fresh_mfa(request)
        new, reason = str(request.data.get("status", "")), str(request.data.get("reason", "")).strip()[:200]
        if new not in (AccountStatus.SUSPENDED, AccountStatus.ACTIVE, AccountStatus.ARCHIVED) or len(reason) < 3:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"reason": ["اذكر السبب (3 أحرف على الأقل)."]})
        with transaction.atomic():
            u = _target(request.user, pk)
            if new != AccountStatus.ACTIVE and aa.is_owner(u) and not _active_owners(exclude_pk=u.pk):
                raise ApiError("last_owner", "يجب أن يبقى مالك نشط واحد على الأقل.", 409)
            u.status, u.status_reason, u.status_changed_at = new, reason, timezone.now()
            u.save(update_fields=["status", "status_reason", "status_changed_at"])
            if new != AccountStatus.ACTIVE:
                AuthToken.objects.filter(user=u, revoked_at__isnull=True).update(revoked_at=timezone.now())
            audit("admin.reactivated" if new == AccountStatus.ACTIVE else "admin.suspended", actor=request.user, target=u,
                  request=request, status=new, reason=reason)
        return Response(admin_out(u, request.user))


def accept_admin_invitation(inv: Invitation, *, email: str, full_name: str, password: str, request) -> User:
    """Called by the invitation acceptance view (inside its transaction): the new admin gets exactly the access chosen
    by the inviter. Two-step verification is set up at the first portal sign-in (required for invited admins)."""
    user = User.objects.create_user(email, password, full_name=full_name, role=Role.ADMIN, is_staff=True)
    AdminProfile.objects.create(user=user, access_level=inv.admin_level or "admin", preset=inv.admin_preset or "custom",
                                permissions=[] if inv.admin_level == "owner" else list(inv.admin_permissions or []),
                                created_by=inv.created_by)
    audit("admin.setup_completed", actor=user, target=user, request=request, level=inv.admin_level, preset=inv.admin_preset)
    return user


ADMIN_URL = lambda: (settings.ADMIN_URL or settings.FRONTEND_URL) + "/admin/"  # noqa: E731
