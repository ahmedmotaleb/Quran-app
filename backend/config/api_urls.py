from django.urls import include, path

from apps.assessments import views as assessments
from apps.learning import views as learning
from apps.media import views as media
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
    path("assignments/<int:pk>/submissions", learning.SubmissionCreate.as_view()),
    path("submissions", learning.SubmissionList.as_view()),
    path("submissions/<int:pk>", learning.SubmissionDetail.as_view()),
    path("submissions/<int:pk>/feedback", learning.FeedbackCreate.as_view()),
    path("lessons", learning.LessonList.as_view()),
    path("lessons/<int:pk>", learning.LessonDetail.as_view()),
    path("lessons/<int:pk>/complete", learning.LessonComplete.as_view()),
    # Quizzes
    path("tests", assessments.TestList.as_view()),
    path("tests/<int:pk>", assessments.TestDetail.as_view()),
    path("tests/<int:pk>/attempts", assessments.AttemptStart.as_view()),
    path("attempts/<int:pk>", assessments.AttemptDetail.as_view()),
    path("attempts/<int:pk>/submit", assessments.AttemptSubmit.as_view()),
    path("teacher/grading", assessments.PendingGrading.as_view()),
    path("answers/<int:pk>/grade", assessments.GradeAnswer.as_view()),
    # Private media
    path("media/recitations", media.RecitationUpload.as_view()),
    path("media/voice-feedback", media.VoiceFeedbackUpload.as_view()),
    path("media/<uuid:pk>", media.MediaDetail.as_view()),
    path("media/<uuid:pk>/content", media.MediaContent.as_view(), name="media-content"),
    # Scheduling & booking
    path("teachers/<int:pk>/slots", scheduling.TeacherSlots.as_view()),
    path("teacher/occurrences", scheduling.TeacherOccurrences.as_view()),
    path("teacher/occurrences/<int:pk>/close", scheduling.TeacherOccurrenceClose.as_view()),
    path("bookings", scheduling.BookingList.as_view()),
    path("bookings/<int:pk>", scheduling.BookingDetail.as_view()),
    path("bookings/<int:pk>/cancel", scheduling.BookingCancel.as_view()),
    path("bookings/<int:pk>/reschedule", scheduling.BookingReschedule.as_view()),
    path("bookings/<int:pk>/attendance", scheduling.BookingAttendance.as_view()),
    # Notifications
    path("notifications", notifications.NotificationList.as_view()),
    path("notifications/read", notifications.NotificationRead.as_view()),
]
