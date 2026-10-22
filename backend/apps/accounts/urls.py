from django.urls import path

from . import invitations as inv
from . import trusted
from . import views as v

urlpatterns = [
    # Learning app (students, teachers, parents)
    path("auth/csrf", v.CsrfView.as_view()),
    path("auth/register", v.RegisterView.as_view()),
    path("auth/login", v.LoginView.as_view()),
    path("auth/logout", v.LogoutView.as_view()),
    path("auth/password/forgot", v.PasswordForgotView.as_view()),
    path("auth/password/reset", v.PasswordResetView.as_view()),
    path("auth/password/change", v.PasswordChangeView.as_view()),
    path("auth/invitations/accept", v.AcceptInvitationView.as_view()),
    path("me", v.MeView.as_view()),
    path("me/onboarding", v.OnboardingView.as_view()),
    path("invitations", inv.InvitationListCreate.as_view()),
    path("invitations/<int:pk>/resend", inv.InvitationResend.as_view()),
    path("invitations/<int:pk>/revoke", inv.InvitationRevoke.as_view()),
    path("teachers", v.TeacherDirectory.as_view()),
    path("teachers/<int:pk>", v.TeacherDetail.as_view()),
    path("teacher/students", v.MyStudents.as_view()),
    path("parent/children", v.MyChildren.as_view()),
    # Admin portal (separate sign-in)
    path("admin/auth/login", v.AdminLoginView.as_view()),
    path("admin/mfa/setup", v.MfaSetupView.as_view()),
    path("admin/mfa/confirm", v.MfaConfirmView.as_view()),
    path("admin/trusted-devices", trusted.TrustedDeviceList.as_view()),
    path("admin/trusted-devices/<int:pk>/revoke", trusted.TrustedDeviceRevoke.as_view()),
    path("admin/users", v.AdminUserList.as_view()),
    path("admin/users/counts", v.AdminUserCounts.as_view()),
    path("admin/users/<int:pk>", v.AdminUserDetail.as_view()),
    path("admin/users/<int:pk>/status", v.AdminUserStatus.as_view()),
    path("admin/users/<int:pk>/setup-link", v.AdminUserSetupLink.as_view()),
    path("admin/teachers/<int:pk>/approval", v.AdminTeacherApproval.as_view()),
    path("admin/teacher-assignments", v.AdminAssignmentCreate.as_view()),
    path("admin/teacher-assignments/<int:pk>/end", v.AdminAssignmentEnd.as_view()),
    path("admin/guardian-links", v.AdminGuardianLinkCreate.as_view()),
    path("admin/guardian-links/<int:pk>/revoke", v.AdminGuardianLinkRevoke.as_view()),
]
