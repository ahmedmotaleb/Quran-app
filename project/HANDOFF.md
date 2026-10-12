# Halqa (حَلْقة) — Prototype handoff

Files: `Halqa App.dc.html` (mobile: student/teacher/parent + auth), `Halqa Admin.dc.html` (desktop admin), `Halqa Design System.dc.html`.

## Demo accounts (password `halqa123`)
yousef@halqa.app (student) · teacher@halqa.app · parent@halqa.app · admin → separate admin portal link.

## What is real vs. simulated
- Real: Quran text (alquran.cloud, Uthmani/Tanzil), ayah audio (everyayah.com, Alafasy), microphone recording via MediaRecorder with playback.
- Simulated: auth, upload, booking persistence, live video, notifications, file downloads, payments. All labelled in-UI.

## Screens
Auth: splash, intro, login, signup, forgot, onboarding (3 steps).
Student: home, plan (حفظ/مراجعة/تجويد), task detail, recorder (idle/permission/recording/paused/review/too-short/uploading/failed/success), teacher feedback (timestamped notes, scores, voice note), mushaf (surah picker, range, jump, bookmark, repeat ×1/3/5, font size), circles (teachers/bookings/lessons/quizzes), teacher profile + slots, booking review, confirmation, session details (reschedule/cancel), waiting room → live → reconnecting/failed → ended, lesson, quiz, progress, account (notifications, font scale, timezone).
Teacher: today, students + profile, create assignment (range validation), reviews list, review recording (timestamp notes, 1–5 ratings, approve/redo, voice note), schedule (sessions + availability toggles), create lecture/quiz.
Parent: child switcher, next session, attendance, tasks, progress, latest feedback.
Admin: overview, users & linking, teachers, content moderation, subscriptions.

## Suggested backend entities
User(role), StudentProfile, ParentLink, TeacherProfile, Assignment(type, surah, from, to, due, status), Submission(audio_url, duration), Review(scores, decision, notes[t,text], voice_url), AvailabilitySlot(utc), Booking(status), Session(room_id, summary), Lesson, Quiz/Question/Attempt, Subscription.
Store all times in UTC; render in user timezone. Status enums: not_started → in_progress → submitted → reviewed.
