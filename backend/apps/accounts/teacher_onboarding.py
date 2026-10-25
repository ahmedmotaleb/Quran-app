"""Teacher onboarding (owner request, 23 Oct 2026): the admin's «دعوة معلم» creates the teacher account at once.

1. Admin enters name + email → a teacher User (no usable password yet, status active so the account can sign in once
   a password is set) and an unapproved TeacherProfile are created in one transaction.
2. The password-setup email «إعداد حساب المعلم في حَلْقة» is sent directly (#/reset, Django's one-use token); the
   delivery result is stored on the account and shown to admins, who can resend it.
3. Because the account exists, «نسيت كلمة المرور؟» works even if the first email was lost.
4. Approval is separate: the teacher signs in, sees «بانتظار الاعتماد», and appears to students only once approved.

`migrate_open_invitations` converts open teacher_account invitations from the previous flow.
"""
from __future__ import annotations

from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.audit import audit
from apps.core.exceptions import ApiError

from .models import AccountStatus, Invitation, Role, TeacherProfile, User
from .permissions import IsAdminRole


class TeacherIn(serializers.Serializer):
    full_name = serializers.CharField(min_length=2, max_length=120)
    email = serializers.EmailField()
    gender = serializers.ChoiceField(choices=["male", "female", ""], required=False, default="")  # «الشيخ» / «الأستاذة»


def check_email(email: str) -> None:
    """Refuse emails that already have an account, with the next step for each case (no duplicate accounts)."""
    existing = User.objects.filter(email__iexact=email).first()
    if existing is None:
        return
    if existing.role == Role.STUDENT and existing.status not in (AccountStatus.DELETED,):
        raise ApiError("existing_student", f"هذا البريد مسجّل بالفعل كحساب طالب ({existing.full_name}). لم يُنشأ حساب جديد. "
                       "يمكنك ترقية حساب الطالب نفسه إلى معلم.", 409, {"user": [str(existing.pk)], "role": [existing.role]})
    if existing.role == Role.ADMIN:
        raise ApiError("email_is_admin", "هذا البريد لحساب إدارة، ولا يكون الحساب الواحد مديرًا ومعلمًا معًا. استخدم بريدًا آخر.", 409,
                       {"email": ["بريد حساب إدارة."]})
    if existing.role == Role.TEACHER:
        raise ApiError("teacher_exists", "لهذا البريد حساب معلم بالفعل. افتح سجله لإعادة إرسال رابط الإعداد.", 409,
                       {"email": ["حساب معلم موجود."], "user": [str(existing.pk)]})
    raise ApiError("email_taken", "هذا البريد مسجّل بالفعل لحساب آخر. استخدم بريدًا آخر لحساب المعلم.", 409, {"email": ["بريد مسجّل."]})


def create_teacher(full_name: str, email: str, actor=None, request=None, gender: str = "") -> User:
    email = email.strip().lower()
    check_email(email)
    try:
        with transaction.atomic():
            # The stored name stays plain: a title typed into it is removed (it is added when shown, display.py).
            from .display import strip_title

            user = User.objects.create_user(email, None, full_name=strip_title(full_name), role=Role.TEACHER, gender=gender)  # unusable password
            TeacherProfile.objects.create(user=user)  # approved_at stays empty until an admin approves
            # The account replaces any open invitation of the previous flow for this address.
            Invitation.objects.filter(purpose=Invitation.Purpose.TEACHER_ACCOUNT, email=email, revoked_at__isnull=True, uses=0).update(
                revoked_at=timezone.now(), revoke_reason="replaced")
            audit("admin.teacher_created", actor=actor, target=user, request=request)
    except IntegrityError:  # created at the same moment by another request
        raise ApiError("teacher_exists", "لهذا البريد حساب بالفعل.", 409, {"email": ["بريد مسجّل."]}) from None
    return user


class AdminTeacherCreate(APIView):
    """POST {full_name, email}: «إنشاء الحساب وإرسال رابط الإعداد». Answers with the account and the email result."""

    permission_classes = [IsAdminRole]
    admin_perm = "invitations.send"

    def post(self, request):
        from .serializers import AdminUserSerializer
        from .views import send_setup_email

        s = TeacherIn(data=request.data)
        s.is_valid(raise_exception=True)
        user = create_teacher(s.validated_data["full_name"], s.validated_data["email"], request.user, request, gender=s.validated_data["gender"])
        sent = send_setup_email(user, request.user, request)
        user.refresh_from_db()
        return Response({**AdminUserSerializer(user, context={"request": request}).data, "setup_email_sent": sent, "sent_to": user.email},
                        status=201)


def migrate_open_invitations(apply: bool, out) -> dict:
    """Open teacher_account invitations (previous flow) → teacher accounts + setup email. Dry run unless `apply`.
    An address that already belongs to a student is left for the promotion workflow; any other existing account is
    skipped; nothing is created twice."""
    from .views import send_setup_email

    stats = {"open": 0, "accounts_created": 0, "emailed": 0, "email_failed": 0, "student_promotion_needed": 0, "skipped_existing": 0, "no_email": 0}
    seen: set[str] = set()
    for inv in Invitation.objects.filter(purpose=Invitation.Purpose.TEACHER_ACCOUNT, revoked_at__isnull=True, uses=0).order_by("created_at"):
        if inv.status not in ("pending", "failed", "expired"):
            continue
        stats["open"] += 1
        email = (inv.email or "").strip().lower()
        if not email:
            stats["no_email"] += 1
            out(f"invitation {inv.pk}: no email — left as is (revoke it from the admin portal if unused)")
            continue
        if email in seen:
            continue
        seen.add(email)
        existing = User.objects.filter(email__iexact=email).first()
        if existing is not None:
            key = "student_promotion_needed" if existing.role == Role.STUDENT else "skipped_existing"
            stats[key] += 1
            out(f"invitation {inv.pk}: address belongs to user {existing.pk} ({existing.role}) — "
                + ("use «ترقية إلى معلم»" if key == "student_promotion_needed" else "skipped"))
            continue
        if not apply:
            stats["accounts_created"] += 1
            out(f"invitation {inv.pk}: would create a teacher account and email the setup link")
            continue
        name = email.split("@")[0]  # the previous flow asked the teacher for the name; the admin can edit it
        user = create_teacher(name, email)
        stats["accounts_created"] += 1
        sent = send_setup_email(user)
        stats["emailed" if sent else "email_failed"] += 1
        audit("ops.teacher_invitation_migrated", target=user, invitation=inv.pk, emailed=sent)
        out(f"invitation {inv.pk}: created user {user.pk}, setup email {'sent' if sent else 'FAILED'}")
    return stats
