"""Direct email invitations (pack prompt 37).

The server creates the one-time invitation and emails the link itself; the API answers with delivery status, never the
code or link. The one exception is `share_link: true`, which the inviter sets explicitly to also send the link over
WhatsApp (owner request, 22 October 2026): only then is the link returned, once, to that inviter.

- Resend replaces the code (the old one stops working) with a fresh expiry, at most once a minute per invitation.
- An email that already has an account is not invited again; an open invitation for the same person is resent
  instead of a second one being created.
- Audit: invitation.created / email_sent / email_failed / resent / revoked / accepted, with the purpose and the
  recipient's email domain — never the code, link or full address.
"""
from __future__ import annotations

from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from rest_framework import serializers
from rest_framework.generics import get_object_or_404
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.audit import audit
from apps.core.exceptions import ApiError

from .emails import send_link_email
from .models import AccountStatus, Invitation, Role, User

P = Invitation.Purpose
RESEND_SECONDS = 60
EMAIL_TEXT = {
    P.TEACHER_ACCOUNT: ("دعوة للانضمام إلى حَلْقة كمعلم", "دعتك إدارة حَلْقة للانضمام معلمًا في منصة تحفيظ القرآن الكريم. "
                        "أنشئ حسابك من الرابط التالي، وسيكون حساب معلم معتمدًا.", "إنشاء حساب المعلم"),
    P.GUARDIAN_LINK: ("دعوة ولي أمر إلى حَلْقة", "دعتك إدارة حَلْقة لمتابعة ابنك أو ابنتك في المنصة بصفتك ولي الأمر. "
                      "افتح الرابط ثم سجّل الدخول بحساب ولي الأمر لإتمام الربط.", "قبول الدعوة"),
    P.STUDENT_TEACHER: ("دعوة للانضمام إلى حَلْقة", "دعاك معلمك للانضمام إلى حلقته في منصة حَلْقة لتحفيظ القرآن الكريم. "
                        "افتح الرابط ثم سجّل الدخول بحساب الطالب.", "الانضمام إلى المعلم"),
    P.ADMIN_ACCOUNT: ("دعوة للانضمام إلى إدارة حَلْقة", "دعتك إدارة حَلْقة للانضمام إلى فريق الإدارة. أنشئ حسابك من الرابط التالي، "
                      "وعند أول دخول إلى بوابة الإدارة ستفعّل التحقق بخطوتين.", "إنشاء حساب المسؤول"),
}
# Which admin permission manages each kind of invitation (admin_access.py).
INVITE_PERM = {P.TEACHER_ACCOUNT: "invitations.send", P.GUARDIAN_LINK: "parents.link_child", P.ADMIN_ACCOUNT: "admins.manage"}


def _link(raw: str, purpose: str = "") -> str:
    # `kind` only changes the page's wording; the server decides what the invitation creates.
    return f"{settings.FRONTEND_URL}/#/invite?code={raw}" + ("&kind=admin" if purpose == P.ADMIN_ACCOUNT else "")


def _domain(email: str) -> str:
    return email.split("@")[-1] if email else ""


def _send(inv: Invitation, raw: str, by, request, event: str) -> bool:
    subject, intro, cta = EMAIL_TEXT[inv.purpose]
    ok = bool(inv.email) and send_link_email(inv.email, subject=subject, intro=intro, cta=cta, link=_link(raw, inv.purpose),
                                              expires_at=inv.expires_at, one_time=inv.max_uses == 1)
    if inv.email:
        inv.email_status, inv.last_sent_at, inv.send_count = ("sent" if ok else "failed"), timezone.now(), inv.send_count + 1
        inv.save(update_fields=["email_status", "last_sent_at", "send_count", "updated_at"])
        audit("invitation.email_sent" if ok else "invitation.email_failed", actor=by, target=inv, request=request,
              purpose=inv.purpose, to_domain=_domain(inv.email), via=event)
    return ok


def invitation_out(inv: Invitation) -> dict:
    return {"id": inv.pk, "purpose": inv.purpose, "purpose_label": P(inv.purpose).label, "email": inv.email,
            "student": inv.student_id, "teacher": inv.teacher_id, "status": inv.status, "email_status": inv.email_status,
            "send_count": inv.send_count, "last_sent_at": inv.last_sent_at.isoformat() if inv.last_sent_at else None,
            "expires_at": inv.expires_at.isoformat(), "created_at": inv.created_at.isoformat(),
            "created_by": inv.created_by.full_name if inv.created_by_id else None}


class InvitationIn(serializers.Serializer):
    # Admin invitations are made in «الإدارة والصلاحيات» (admin_management.py), never through this endpoint.
    purpose = serializers.ChoiceField(choices=[c for c in P.choices if c[0] != P.ADMIN_ACCOUNT])
    email = serializers.EmailField(required=False, allow_blank=True, default="")
    student = serializers.PrimaryKeyRelatedField(queryset=User.objects.filter(role=Role.STUDENT), required=False, allow_null=True)
    days = serializers.IntegerField(min_value=1, max_value=30, default=7)
    share_link = serializers.BooleanField(default=False)

    def validate(self, attrs):
        if attrs["purpose"] == P.GUARDIAN_LINK and not attrs.get("student"):
            raise serializers.ValidationError({"student": ["حدّد الطالب المراد ربطه."]})
        if not attrs["email"] and not attrs["share_link"]:
            raise serializers.ValidationError({"email": ["اكتب البريد الإلكتروني لإرسال الدعوة."]})
        attrs["email"] = attrs["email"].strip().lower()
        return attrs


def _may_manage(user, inv: Invitation) -> bool:
    from .admin_access import has

    if user.role == Role.ADMIN:
        return has(user, INVITE_PERM.get(inv.purpose, "admins.manage"))
    return inv.created_by_id == user.pk and inv.purpose != P.ADMIN_ACCOUNT


class InvitationListCreate(APIView):
    """GET: invitations the caller may manage (admin: all; teacher: own), newest first, no codes.
    POST: create and email an invitation (admins: any purpose; teachers: student_teacher only)."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        u = request.user
        if u.role not in (Role.ADMIN, Role.TEACHER):
            raise ApiError("permission_denied", "ليست لديك صلاحية لهذا الإجراء.", 403)
        qs = Invitation.objects.select_related("created_by").exclude(revoke_reason="replaced").order_by("-created_at")
        if u.role == Role.TEACHER:
            qs = qs.filter(created_by=u)
        else:
            from .admin_access import perms_of

            mine = perms_of(u)
            qs = qs.filter(purpose__in=[p for p, need in INVITE_PERM.items() if need in mine])
        if request.query_params.get("purpose") in P.values:
            qs = qs.filter(purpose=request.query_params["purpose"])
        rows = [invitation_out(i) for i in qs[:200]]
        if request.query_params.get("open") == "1":
            rows = [r for r in rows if r["status"] in ("pending", "failed", "expired")]
        return Response({"results": rows})

    def post(self, request):
        if request.user.role not in (Role.ADMIN, Role.TEACHER):
            raise ApiError("permission_denied", "ليست لديك صلاحية لهذا الإجراء.", 403)
        s = InvitationIn(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        u, purpose, email = request.user, d["purpose"], d["email"]
        if not (u.role == Role.ADMIN or (u.role == Role.TEACHER and purpose == P.STUDENT_TEACHER)):
            raise ApiError("permission_denied", "ليست لديك صلاحية لهذا الإجراء.", 403)
        if u.role == Role.ADMIN:
            from .admin_access import require

            require(u, INVITE_PERM.get(purpose, "invitations.send"))
        if email:
            existing = User.objects.filter(email__iexact=email).first()
            if existing and purpose == P.TEACHER_ACCOUNT:
                if existing.status in (AccountStatus.SUSPENDED, AccountStatus.ARCHIVED):
                    raise ApiError("account_inactive", "لهذا البريد حساب موقوف أو مؤرشف. أعد تفعيله من صفحة الحساب.", 409)
                if existing.role == Role.ADMIN:
                    raise ApiError("email_is_admin", "هذا البريد لحساب إدارة، ولا يكون الحساب الواحد مديرًا ومعلمًا معًا. "
                                   "ادعُ المعلم ببريد آخر.", 409, {"email": ["بريد حساب إدارة."]})
                if existing.role == Role.STUDENT and u.role == Role.ADMIN:
                    # Nothing is emailed: the admin may promote this student account instead (promote-teacher).
                    raise ApiError("existing_student", f"هذا البريد مسجّل بالفعل كحساب طالب ({existing.full_name}). "
                                   "لم تُرسل أي دعوة. يمكنك ترقية حساب الطالب نفسه إلى معلم.", 409,
                                   {"user": [str(existing.pk)], "role": [existing.role]})
                if existing.role == Role.PARENT:
                    raise ApiError("email_taken", "هذا البريد مسجّل بالفعل كحساب ولي أمر. استخدم بريدًا آخر لحساب المعلم.", 409,
                                   {"email": ["بريد حساب ولي أمر."]})
                raise ApiError("email_taken", "لهذا البريد حساب في حَلْقة بالفعل.", 409, {"email": ["هذا البريد مسجّل بالفعل."]})
            if existing and existing.status in (AccountStatus.SUSPENDED, AccountStatus.ARCHIVED):
                raise ApiError("account_inactive", "الحساب المرتبط بهذا البريد موقوف أو مؤرشف.", 409)
            open_inv = [i for i in Invitation.objects.filter(purpose=purpose, email=email, revoked_at__isnull=True,
                                                             student=d.get("student"),
                                                             teacher=u if purpose == P.STUDENT_TEACHER else None)
                        if i.status in ("pending", "failed")]
            if open_inv:
                raise ApiError("already_invited", "توجد دعوة مفتوحة لهذا البريد. أعد إرسالها بدل إنشاء دعوة جديدة.", 409,
                               {"invitation": [str(open_inv[0].pk)]})
        with transaction.atomic():
            inv, raw = Invitation.issue(purpose=purpose, created_by=u, days=d["days"], email=email, student=d.get("student"),
                                        teacher=u if purpose == P.STUDENT_TEACHER else None)
            audit("invitation.created", actor=u, target=inv, request=request, purpose=purpose, to_domain=_domain(email),
                  share_link=d["share_link"])
        sent = _send(inv, raw, u, request, "create") if email else False
        out = {**invitation_out(inv), "email_sent": sent}
        if d["share_link"]:
            out["link"] = _link(raw, inv.purpose)  # asked for explicitly, to also send over WhatsApp; shown to the inviter once
        return Response(out, status=201)


class InvitationResend(APIView):
    """New code (the previous one stops working) with a fresh expiry, emailed again. Throttled per invitation."""

    permission_classes = [IsAuthenticated]

    def post(self, request, pk):
        u = request.user
        with transaction.atomic():
            old = get_object_or_404(Invitation.objects.select_for_update(), pk=pk)
            if not _may_manage(u, old):
                raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
            if old.status in ("accepted", "revoked"):
                raise ApiError("not_resendable", "قُبلت هذه الدعوة أو أُلغيت.", 409)
            if old.last_sent_at and old.last_sent_at > timezone.now() - timedelta(seconds=RESEND_SECONDS):
                raise ApiError("too_soon", "أُرسلت الدعوة قبل لحظات. انتظر دقيقة ثم أعد المحاولة.", 429)
            share = request.data.get("share_link") is True
            if not old.email and not share:
                raise ApiError("invalid", "لا يوجد بريد لهذه الدعوة.", 400)
            old.revoked_at, old.revoke_reason = timezone.now(), "replaced"
            old.save(update_fields=["revoked_at", "revoke_reason", "updated_at"])
            days = max(1, round((old.expires_at - old.created_at).total_seconds() / 86400))
            inv, raw = Invitation.issue(purpose=old.purpose, created_by=old.created_by, days=days, email=old.email,
                                        student=old.student, teacher=old.teacher)
            inv.send_count = old.send_count
            inv.save(update_fields=["send_count"])
            audit("invitation.resent", actor=u, target=inv, request=request, purpose=inv.purpose, replaces=old.pk,
                  to_domain=_domain(inv.email))
        sent = _send(inv, raw, u, request, "resend") if inv.email else False
        out = {**invitation_out(inv), "email_sent": sent}
        if share:
            out["link"] = _link(raw, inv.purpose)
        return Response(out, status=201)


class InvitationRevoke(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, pk):
        inv = get_object_or_404(Invitation, pk=pk)
        if not _may_manage(request.user, inv):
            raise ApiError("not_found", "العنصر المطلوب غير موجود.", 404)
        if inv.status == "accepted":
            raise ApiError("accepted", "قُبلت هذه الدعوة بالفعل.", 409)
        if not inv.revoked_at:
            inv.revoked_at, inv.revoke_reason = timezone.now(), "revoked"
            inv.save(update_fields=["revoked_at", "revoke_reason", "updated_at"])
            audit("invitation.revoked", actor=request.user, target=inv, request=request, purpose=inv.purpose)
        return Response(invitation_out(inv))
