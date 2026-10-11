from django.urls import include, path

from apps.learning import views as learning
from apps.notifications import views as notifications
from apps.quran import views as quran
from apps.scheduling import views as scheduling

urlpatterns = [
    path("", include("apps.accounts.urls")),
    # Quran (verified, versioned reference data)
    path("quran/source", quran.SourceView.as_view()),
    path("quran/surahs", quran.SurahList.as_view()),
    path("quran/surahs/<int:number>", quran.SurahText.as_view()),
    # Learning
    path("assignments", learning.AssignmentList.as_view()),
    path("assignments/<int:pk>", learning.AssignmentDetail.as_view()),
    path("assignments/<int:pk>/start", learning.AssignmentStart.as_view()),
    # Scheduling & booking
    path("teachers/<int:pk>/slots", scheduling.TeacherSlots.as_view()),
    path("bookings", scheduling.BookingList.as_view()),
    path("bookings/<int:pk>", scheduling.BookingDetail.as_view()),
    path("bookings/<int:pk>/cancel", scheduling.BookingCancel.as_view()),
    path("bookings/<int:pk>/reschedule", scheduling.BookingReschedule.as_view()),
    path("bookings/<int:pk>/attendance", scheduling.BookingAttendance.as_view()),
    # Notifications
    path("notifications", notifications.NotificationList.as_view()),
    path("notifications/read", notifications.NotificationRead.as_view()),
]
