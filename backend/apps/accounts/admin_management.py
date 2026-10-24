"""«الإدارة والصلاحيات»: invite admins by email, change their access, suspend/reactivate them (admin_access.py).

Rules, all checked on the server inside one transaction:
- Requires `admins.manage`, and a current authenticator code for every change (fresh MFA).
- Nobody changes their own access or status here.
- Only an owner creates, edits, suspends or reactivates an owner, and only an owner grants the owner level.
- An admin can only grant permissions they hold themselves.
- There is always at least one active owner (row locks on the owners make concurrent changes safe).
- Audit: admin.invited / setup_completed / permission_changed / preset_changed / suspended / reactivated, with
  the permissions added and removed. Never the password, the TOTP secret or the setup code.

Teacher + admin (24 October 2026): an existing teacher can be given admin access on the same account
(«منح صلاحيات إدارة لمعلم»): the role stays teacher, an AdminProfile is added, and everything the teacher has
(students, sessions, Google Calendar, recordings, sign-in methods) stays as it is. The access can be paused
(«تعطيل صلاحيات الإدارة», AdminProfile.is_active) or removed («إزالة صلاحيات الإدارة») without touching the teacher
account. Audit: admin.access_granted_to_teacher / access_suspended / access_reactivated / access_removed_from_teacher.
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
from .phones import mask

INVITE_DAYS = 3


def admin_out(u: User, viewer) -> dict:
    prof = getattr(u, "admin_profile", None)
    return {"teacher_admin": aa.is_teacher_admin(u), "access_active": bool(prof.is_active) if prof else True,
            "access_reason": prof.status_reason if prof else "","id": u.pk, "full_name": u.full_name, "email": u.email,
            "phone": u.phone if aa.has(viewer, "users.view_contact") else mask(u.phone_e164 or u.phone),
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
    qs = (AdminProfile.objects.select_for_update().filter(access_level="owner", is_active=True, user__status=AccountStatus.ACTIVE,
                                                          user__is_active=True))
    return [p for p in qs if p.user_id != exclude_pk]


def _target(actor, pk: int) -> User:
    from django.db.models import Q

    u = (User.objects.select_for_update(of=("self",)).filter(Q(role=Role.ADMIN) | Q(role=Role.TEACHER, admin_profile__isnull=False), pk=pk)
         .exclude(status=AccountStatus.DELETED).select_related("admin_profile").first())
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
        from django.db.models import Q

        admins = (User.objects.filter(Q(role=Role.ADMIN) | Q(role=Role.TEACHER, admin_profile__isnull=False))
                  .exclude(status=AccountStatus.DELETED).select_related("admin_profile").order_by("date_joined"))
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
        existing = User.objects.filter(email__iexact=email).select_related("admin_profile").first()
        if existing is not None and existing.role == Role.TEACHER and getattr(existing, "admin_profile", None) is None \
                and existing.status != AccountStatus.DELETED:
            # Nothing is emailed: the portal offers «منح صلاحيات إدارة» for this teacher's own account instead.
            raise ApiError("teacher_exists", "هذا البريد يخص معلمًا موجودًا. يمكنك منحه صلاحيات الإدارة من حسابه الحالي.", 409,
                           {"user": [str(existing.pk)], "full_name": [existing.full_name]})
        if existing is not None:
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
            if aa.is_teacher_admin(u):  # the teacher account stays as it is; only the admin access changes
                raise ApiError("teacher_admin", "هذا الحساب لمعلم. استخدم «تعطيل صلاحيات الإدارة» أو «إزالة صلاحيات الإدارة».", 409)
            if new != AccountStatus.ACTIVE and aa.is_owner(u) and not _active_owners(exclude_pk=u.pk):
                raise ApiError("last_owner", "يجب أن يبقى مالك نشط واحد على الأقل.", 409)
            u.status, u.status_reason, u.status_changed_at = new, reason, timezone.now()
            u.save(update_fields=["status", "status_reason", "status_changed_at"])
            if new != AccountStatus.ACTIVE:
                AuthToken.objects.filter(user=u, revoked_at__isnull=True).update(revoked_at=timezone.now())
            audit("admin.reactivated" if new == AccountStatus.ACTIVE else "admin.suspended", actor=request.user, target=u,
                  request=request, status=new, reason=reason)
        return Response(admin_out(u, request.user))


# ---- teacher + admin on the same account ---------------------------------------------------------------------------
def _contact_q(q: str):
    from django.db.models import Q

    digits = "".join(ch for ch in q if ch.isdigit())
    cond = Q(full_name__icontains=q) | Q(email__icontains=q)
    if len(digits) >= 4:
        cond |= Q(phone__contains=digits) | Q(phone_e164__contains=digits)
    return cond


class AdminTeacherCandidates(APIView):
    """GET ?q= (name, email or phone): active teachers without admin access, for «منح صلاحيات إدارة لمعلم»."""

    permission_classes = [IsAdminRole]
    admin_perm = "admins.manage"

    def get(self, request):
        q = str(request.query_params.get("q", "")).strip()[:80]
        qs = (User.objects.filter(role=Role.TEACHER, admin_profile__isnull=True, is_active=True)
              .exclude(status__in=[AccountStatus.DELETED, AccountStatus.ARCHIVED]).order_by("full_name"))
        if q:
            qs = qs.filter(_contact_q(q))
        see = aa.has(request.user, "users.view_contact")
        return Response({"results": [{"id": u.pk, "full_name": u.full_name, "email": u.email, "status": u.status,
                                      "phone": u.phone if see else mask(u.phone_e164 or u.phone), "mfa_enabled": u.mfa_enabled}
                                     for u in qs[:20]]})


def _notify_access(u: User, kind: str, title: str, body: str) -> None:
    from apps.notifications.services import notify

    notify(u, kind, title, body, link=ADMIN_URL(), dedupe=f"{kind}:{u.pk}:{timezone.now().isoformat()}", data={})


class AdminGrantTeacherAccess(APIView):
    """POST {teacher, level, preset, permissions, otp}: give an existing teacher admin access on the same account
    (fresh MFA). The role stays «معلم»; nothing of the teacher's is changed. Two-step verification is required at the
    teacher's first admin sign-in (their existing authenticator, if any, is used as it is)."""

    permission_classes = [IsAdminRole]
    admin_perm = "admins.manage"

    def post(self, request):
        aa.require_fresh_mfa(request)
        d = request.data
        tid = d.get("teacher")
        if not str(tid or "").isdigit():
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"teacher": ["اختر المعلم."]})
        level, preset, perms = _resolve(str(d.get("level", "admin")), str(d.get("preset", "")), d.get("permissions"))
        _may_grant(request.user, level, perms)
        with transaction.atomic():
            u = User.objects.select_for_update(of=("self",)).filter(pk=int(tid)).select_related("admin_profile").first()
            if u is None or u.role != Role.TEACHER or u.status == AccountStatus.DELETED:
                raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
            if u.pk == request.user.pk:
                raise ApiError("self_change", "لا يمكنك تغيير صلاحياتك أو حالتك بنفسك. اطلب ذلك من مالك آخر.", 403)
            if getattr(u, "admin_profile", None) is not None:
                raise ApiError("already_admin", "لهذا المعلم صلاحيات إدارة بالفعل.", 409)
            if u.status != AccountStatus.ACTIVE or not u.is_active:
                raise ApiError("account_inactive", "حساب المعلم غير نشط. فعّل الحساب أولًا ثم امنحه صلاحيات الإدارة.", 409)
            AdminProfile.objects.create(user=u, access_level=level, preset=preset, permissions=perms, created_by=request.user)
            audit("admin.access_granted_to_teacher", actor=request.user, target=u, request=request, level=level, preset=preset,
                  permissions=sorted(aa.ALL if level == "owner" else perms))
            transaction.on_commit(lambda: _notify_access(
                u, "admin_access_granted", "تم منحك صلاحية الدخول إلى لوحة إدارة حَلْقة.",
                "ادخل من «لوحة الإدارة» في حسابك بنفس البريد وكلمة المرور. سيُطلب منك تفعيل التحقق بخطوتين عند أول دخول "
                "إن لم يكن مفعّلًا. حسابك كمعلم يبقى كما هو."))
        u = User.objects.select_related("admin_profile").get(pk=u.pk)
        return Response(admin_out(u, request.user), status=201)


class AdminTeacherAccess(APIView):
    """POST {action: suspend|reactivate|remove, reason, otp} on a teacher's admin access (fresh MFA). The teacher
    account (role, status, students, sessions) is never changed; the admin portal session ends at once."""

    permission_classes = [IsAdminRole]
    admin_perm = "admins.manage"

    def post(self, request, pk):
        from .models import TrustedDevice

        aa.require_fresh_mfa(request)
        action, reason = str(request.data.get("action", "")), str(request.data.get("reason", "")).strip()[:200]
        if action not in ("suspend", "reactivate", "remove"):
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"action": ["إجراء غير معروف."]})
        if action != "reactivate" and len(reason) < 3:
            raise ApiError("invalid", "تحقق من البيانات المُدخلة.", 400, {"reason": ["اذكر السبب (3 أحرف على الأقل)."]})
        with transaction.atomic():
            u = _target(request.user, pk)
            if not aa.is_teacher_admin(u):
                raise ApiError("not_teacher_admin", "هذا الإجراء لحسابات المعلمين ذوي صلاحيات الإدارة فقط.", 409)
            prof = AdminProfile.objects.select_for_update().get(user=u)
            if action != "reactivate" and prof.is_active and prof.access_level == "owner" and not _active_owners(exclude_pk=u.pk):
                raise ApiError("last_owner", "يجب أن يبقى مالك نشط واحد على الأقل.", 409)
            if action == "suspend" and not prof.is_active or action == "reactivate" and prof.is_active:
                raise ApiError("unchanged", "صلاحيات الإدارة في هذه الحالة بالفعل.", 409)
            now = timezone.now()
            if action == "remove":
                level, preset = prof.access_level, prof.preset
                prof.delete()
                audit("admin.access_removed_from_teacher", actor=request.user, target=u, request=request, level=level,
                      preset=preset, reason=reason)
                note = ("تمت إزالة صلاحيات الإدارة من حسابك", "حسابك كمعلم يبقى كما هو.")
            else:
                prof.is_active, prof.status_reason = action == "reactivate", "" if action == "reactivate" else reason
                prof.save()
                audit("admin.access_reactivated" if action == "reactivate" else "admin.access_suspended", actor=request.user,
                      target=u, request=request, reason=reason)
                note = (("أُعيد تفعيل صلاحيات الإدارة في حسابك", "يمكنك الدخول إلى لوحة الإدارة مرة أخرى.") if action == "reactivate"
                        else ("تم تعطيل صلاحيات الإدارة في حسابك مؤقتًا", "حسابك كمعلم يعمل كالمعتاد."))
            if action != "reactivate":
                # The admin portal session is refused from the next request (AdminPortalSessionAuthentication); a
                # remembered admin browser is forgotten. The teacher app's own session is not touched.
                TrustedDevice.objects.filter(user=u, revoked_at__isnull=True).update(revoked_at=now)
            transaction.on_commit(lambda: _notify_access(u, f"admin_access_{action}", *note))
        u = User.objects.select_related("admin_profile").get(pk=u.pk)
        return Response({**admin_out(u, request.user), "removed": action == "remove"})


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
