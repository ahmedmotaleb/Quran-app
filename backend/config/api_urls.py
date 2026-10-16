from django.urls import include, path

from apps.assessments import admin_views as assess_admin
from apps.core import admin_views as core_admin
from apps.assessments import views as assessments
from apps.learning import admin_views as learn_admin
from apps.learning import progress
from apps.learning import teacher_content
from apps.learning import reviews
from apps.learning import views as learning
from apps.media import views as media
from apps.notifications import views as notifications
from apps.quran import views as quran
from apps.scheduling import admin_views as sched_admin
from apps.scheduling import views as scheduling

urlpatterns = [
    path("", include("apps.accounts.urls")),
    # Quran (verified, versioned reference data)
    path("quran/source", quran.SourceView.as_view()),
    path("quran/surahs", quran.SurahList.as_view()),
    path("quran/surahs/<int:number>", quran.SurahText.as_view()),
    path("quran/position", quran.ReadingPositionView.as_view()),
    path("quran/bookmarks", quran.BookmarkList.as_view()),
    path("quran/bookmarks/<int:pk>", quran.BookmarkDetail.as_view()),
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
    # Progress (one calculation for every role)
    path("progress/me", progress.MyProgress.as_view()),
    path("today", progress.TodayPlan.as_view()),
    path("teacher/students/<int:pk>/progress", progress.TeacherStudentProgress.as_view()),
    path("parent/children/<int:pk>/progress", progress.ChildProgress.as_view()),
    path("admin/progress", progress.AdminProgressSummary.as_view()),
    path("parent/weekly-summary", progress.ParentWeeklySummary.as_view()),
    path("teacher/dashboard", progress.TeacherDashboard.as_view()),
    # Spaced-repetition review schedules
    path("review-schedules", reviews.MyReviewSchedules.as_view()),
    path("teacher/students/<int:pk>/review-schedules", reviews.TeacherReviewSchedules.as_view()),
    path("teacher/review-schedules/<int:pk>", reviews.TeacherReviewOverride.as_view()),
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
    path("media/lesson-files", media.LessonFileUpload.as_view()),
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
    # Admin: circles, sessions, bookings
    path("admin/circles", sched_admin.AdminCircles.as_view()),
    path("admin/circles/<int:pk>", sched_admin.AdminCircleDetail.as_view()),
    path("admin/circles/<int:pk>/state", sched_admin.AdminCircleState.as_view()),
    path("admin/circles/<int:pk>/sessions", sched_admin.AdminCircleSessions.as_view()),
    path("admin/sessions/<int:pk>/cancel", sched_admin.AdminOccurrenceCancel.as_view()),
    path("admin/bookings", sched_admin.AdminBookings.as_view()),
    path("admin/bookings/counts", sched_admin.AdminBookingCounts.as_view()),
    path("admin/bookings/<int:pk>/cancel", sched_admin.AdminBookingCancel.as_view()),
    # Admin: courses, lessons, enrollments, quizzes
    path("teacher/content", teacher_content.TeacherContent.as_view()),
    path("teacher/courses", teacher_content.TeacherCourses.as_view()),
    path("teacher/courses/<int:pk>/lessons", teacher_content.TeacherLessons.as_view()),
    path("teacher/lessons/<int:pk>", teacher_content.TeacherLessonDetail.as_view()),
    path("teacher/tests", teacher_content.TeacherTests.as_view()),
    path("teacher/tests/<int:pk>", teacher_content.TeacherTestDetail.as_view()),
    path("admin/content/drafts", teacher_content.AdminContentDrafts.as_view()),
    path("admin/courses", learn_admin.AdminCourses.as_view()),
    path("admin/courses/<int:pk>", learn_admin.AdminCourseDetail.as_view()),
    path("admin/courses/<int:pk>/state", learn_admin.AdminCourseState.as_view()),
    path("admin/courses/<int:pk>/lessons", learn_admin.AdminLessons.as_view()),
    path("admin/courses/<int:pk>/enrollments", learn_admin.AdminEnrollments.as_view()),
    path("admin/lessons/<int:pk>", learn_admin.AdminLessonDetail.as_view()),
    path("admin/lessons/<int:pk>/state", learn_admin.AdminLessonState.as_view()),
    path("admin/enrollments/<int:pk>/end", learn_admin.AdminEnrollmentEnd.as_view()),
    path("admin/tests", assess_admin.AdminTests.as_view()),
    path("admin/tests/<int:pk>", assess_admin.AdminTestDetail.as_view()),
    path("admin/tests/<int:pk>/state", assess_admin.AdminTestState.as_view()),
    path("admin/tests/<int:pk>/questions", assess_admin.AdminQuestions.as_view()),
    path("admin/questions/<int:pk>", assess_admin.AdminQuestionDetail.as_view()),
    # Settings: admin-managed, and the public subset the apps read
    path("admin/settings", core_admin.AdminSettingsView.as_view()),
    path("admin/audit", core_admin.AdminAudit.as_view()),
    path("settings/public", core_admin.PublicSettings.as_view()),
    # Notifications
    path("notifications", notifications.NotificationList.as_view()),
    path("notifications/read", notifications.NotificationRead.as_view()),
    path("notifications/unread", notifications.UnreadCount.as_view()),
]
