# API contracts (v1)

Base path `/api/v1`. JSON only. Times are ISO-8601 with offset (stored in UTC; rendered in
the server default zone, Africa/Cairo). Lists are paginated:
`{count, next, previous, results}`, `?page=` and `?page_size=` (max 100).

## Authentication

| Client | Mechanism |
| --- | --- |
| Web app / admin portal | Session cookie (HttpOnly, SameSite=Lax). Writes need `X-CSRFToken` (get the cookie from `GET /auth/csrf`). |
| Native clients (none at present — the app is a PWA and uses the cookie session) | `Authorization: Bearer <token>` from `POST /auth/login` with `"client":"native"`. Only a SHA-256 hash is stored. The token expires (30 days by default) and is revoked by logout, password change/reset or suspension. |

### Sign-in identifier: email or verified phone

`POST auth/login` and `POST admin/auth/login` take `identifier`. Older clients may still send `email`.

**Identifier**
- An email address, or a phone number that its owner has **verified**.
- Phones are normalized to E.164 with `phonenumbers`. Local numbers are read in `PHONE_DEFAULT_REGION` (EG by default), so `010…` becomes `+2010…`.
- Every failure gets the same generic answer: «البريد أو رقم الهاتف أو كلمة المرور غير صحيحة.» This covers an unknown email, an unknown or unverified number, and a wrong password.
- An unknown identifier still runs the password hasher.

**Account rules**
- The lockout counts failures per account, so switching between email and phone does not reset it.
- Suspension and archive apply whichever identifier is used.
- Admins still need their authenticator code.
- Password reset stays email-only.

**`POST me/phone/start {phone}`**
- Sends a 6-digit code by SMS.
- Only an HMAC of the code is stored.
- The code expires after 5 minutes, allows 5 wrong tries and works once.
- There is a 60-second wait between sends, and at most 5 sends per hour per account and per number. The `phone` scope also throttles requests.

**`POST me/phone/confirm {code}`**
- On success, the number becomes the account's sign-in number.
- A verified number belongs to one account (partial unique constraint).
- Changing numbers works the same way: the old number keeps working until the new one is confirmed.
- `PATCH me` cannot change a verified number.

**SMS provider (`sms.py`)**
- `SMS_PROVIDER=twilio`, with credentials from Secret Manager.
- `file` is for end-to-end tests only.
- With no provider, `settings/public.phone_verification` is false, `me/phone/start` answers 503 `sms_unavailable`, and email sign-in is unchanged.

**Admin views**
- Admin views mask phones (`+20•••••••678`) unless the admin has `users.view_contact`.
- Admins cannot edit a verified number.

**Audit events**
- `phone.code_sent`, `phone.verify_failed`, `phone.verified` (masked numbers).
- `auth.login` / `auth.login_failed` carry `via`.

### Waiting list and make-up sessions (PROMPT 44)

**Waiting list**
- `GET waitlist` returns the student's entries; reading also expires lapsed offers.
- `POST waitlist {occurrence}` joins the list. It only works when the session is full; otherwise it answers `seat_available`. One open entry per student per session.
- `POST waitlist/{id}/accept` (Idempotency-Key) books the held seat. `POST waitlist/{id}/leave` leaves the list, or declines an offer.
- Free seats = capacity − confirmed bookings − live offers, computed under a row lock on the session.
- A free seat goes to the next waiting student, in join order. It is held for `waitlist_offer_hours`, never past the booking cut-off.
- While held, the seat counts as taken for everyone else, in `book()` and in `seats_left`.
- An expired offer moves to the next person. Suspended students, or students booked at the same time, are skipped.
- The queue is processed on cancellation, on read and hourly (`waitlist_tick` inside `run_scheduled`), so seats freed by bulk paths are not lost.

**Make-up sessions**
- Granted for an approved excuse:
  - by the session's teacher, via `POST bookings/{id}/makeup`, when `makeup_granters` is `teachers_admins`;
  - by an admin with `excuses.review`, via `POST admin/bookings/{id}/makeup`.
- At most one per absence (one-to-one with the source booking).
- Valid for `makeup_expiry_days`. `GET makeup` lists the student's credits.
- `POST bookings` with `makeup_credit` books one replacement session with the same teacher.
- If the teacher or an admin cancels that booking, the credit comes back.
- Disabled by `makeup_enabled`.

**Settings:** `waitlist_offer_hours`, `makeup_enabled`, `makeup_expiry_days`, `makeup_granters`.

**Audit events:** `waitlist.joined`, `waitlist.offered`, `waitlist.offer_expired`, `waitlist.accepted`, `waitlist.left`, `waitlist.closed`; `makeup.granted`, `makeup.used`, `makeup.returned`, `makeup.expired`.

### Creating tasks (PROMPT 43)

- `POST assignments` (teacher): a task for one of the teacher's linked students. In the app, «+ إضافة مهمة» on the student's file opens the form with that student fixed.
- `GET teacher/circles`: the teacher's circles, with `members` and `reachable` counts.
- `POST circles/{id}/assignments` («إرسال مهمة لكل الحلقة», circle teacher only):
  - The body is the task without the student.
  - It creates one task per active member who is linked to the teacher, in one transaction.
  - Answers `{created, skipped, results[]}`.
  - Ended memberships are not members. Suspended accounts and members not linked to this teacher are skipped with a reason; the teacher could not review their recordings.
- `POST admin/assignments` (`assignments.manage`: مدير أكاديمي or owner; not خدمة العملاء or مشاهدة فقط):
  - The responsible `teacher` must be one of the student's linked teachers; when there is exactly one, it may be omitted.
  - A student without a linked teacher is refused with `no_teacher`.
- All paths validate Hafs ranges, audit `assignment.created` and notify the student.

### Teacher onboarding

**Creating the account: `POST admin/teachers {full_name, email}`** («إنشاء الحساب وإرسال رابط الإعداد», `invitations.send`)
- Creates the teacher account immediately: no usable password yet, and an unapproved `TeacherProfile`.
- Sends «إعداد حساب المعلم في حَلْقة» with a `#/reset?uid=…&token=…` link (Django's one-use token).
- Answers with `setup_email_sent` and `sent_to`.
- Email addresses that already have an account are refused:
  - a student account gets `existing_student`, which offers «ترقية إلى معلم»;
  - an admin account gets `email_is_admin`;
  - an existing teacher gets `teacher_exists`;
  - any other account gets `email_taken`.

**After setup**
- The teacher sets a password, then signs in on the normal login and the role routes them.
- `me.teacher_approved` stays false until an admin approves. Unapproved teachers are not listed or bookable.
- «نسيت كلمة المرور؟» works from the start, because the account exists.

**Delivery status and resend**
- The admin record shows `has_password`, `setup_email_status` (sent / failed), `setup_email_last_at` and `setup_email_count`.
- `POST admin/users/{id}/setup-link` resends. It refuses a second send within 30 s.
- With `{share: true}`, only an owner, and only when the email failed, also receives the link to copy.

**Legacy invitations**
- Open `teacher_account` invitations from the previous flow are converted by `manage.py migrate_teacher_invitations [--apply]` (Ops task `migrate-teacher-invitations`). It creates the account, replaces the invitation and sends the setup email.
- Addresses that belong to students are left for promotion. Nothing is created twice.
- Accepting an old invitation no longer approves the teacher.

### Trusted admin devices

- A login that trusted the browser answers `trusted_device` with `expires_at` and `days`.
- A password-only login on a trusted browser answers `used_trusted_device: true`.
- `GET admin/trusted-devices` lists the admin's devices with `created_at`, `last_used_at`, `expires_at` and `current`.
- `POST admin/trusted-devices/{id}/revoke` («إلغاء الثقة») and `DELETE admin/trusted-devices` («إلغاء الثقة من كل الأجهزة») remove trust.
- The cookie is `halqa_admin_trusted`: HttpOnly, Secure, SameSite=Lax, same-origin on the admin service.
- The admin page is never precached by the service worker. On 23 Oct a cached admin page predating the feature never sent `trust_device`, so the code was asked at every sign-in.

## Errors

Every error looks like this:

```json
{"code": "slot_taken", "message": "لم يعد هذا الموعد متاحًا…", "fields": {"…": ["…"]}, "request_id": "…"}
```

`code` is stable for programs; `message` is Arabic for people. `fields` appears on
validation errors. `request_id` also comes back as the `X-Request-ID` header and in
server logs.

## Endpoints

| Method & path | Who | Notes |
| --- | --- | --- |
| `GET /api/health`, `GET /api/ready` | anyone | liveness; DB + migrations readiness |
| `GET auth/csrf` | anyone | sets CSRF cookie |
| `POST auth/register` | anyone | always creates a **student**; `role` in the body is ignored; respects `open_signup` |
| `POST auth/login` | student, teacher, parent | admins get `admin_portal_only` |
| `POST admin/auth/login` | admin | `otp` required when MFA is on |
| `POST auth/logout` | signed in | ends the session or revokes the bearer token |
| `POST auth/password/forgot` | anyone | same answer whether or not the email exists; throttled |
| `POST auth/password/reset` | holder of emailed link | single-use (token is invalidated by the password change); revokes tokens |
| `POST auth/password/change` | signed in | revokes other devices' tokens |
| `POST auth/invitations/accept` | per purpose | teacher account / guardian link / student→teacher |
| `GET, PATCH me` | signed in | name, timezone, phone |
| `PUT me/onboarding` | student | level, goal, preferred days/period |
| `POST invitations` | admin (any purpose); teacher (`student_teacher` only) | code shown once |
| `GET teachers`, `GET teachers/{id}` | learning users | approved, active teachers; `?q=`, `?tag=` |
| `GET teachers/{id}/slots?days=7` | learning users | (1) start times **computed** from the teacher's availability ranges (`id` is a token `s:<teacher>:<epoch>:<minutes>`, `seats_left` 1, `minutes`); (2) existing sessions with seats (circle/group sessions, sessions opened explicitly) and booked individual sessions (`seats_left` 0, for the waitlist). See «Teacher availability» below |
| `GET/PUT… teacher/availability…` | teacher (own), admin (`admin/teachers/{id}/availability…`) | see «Teacher availability» below |
| `GET teacher/students` | teacher | assigned students only: id, name, level, birth year, whether a guardian is linked |
| `GET, POST teacher/occurrences` | teacher | own sessions from 7 days ago to `?days=` ahead, with booked students; POST `{starts_at, minutes}` opens a slot inside the booking window (overlaps refused by the DB) |
| `POST teacher/occurrences/{id}/close` | teacher | only unbooked, future slots; closed slots are never regenerated by weekly rules |
| `GET parent/children` | parent | children with an **active** guardian link only |
| `GET, POST assignments` | list: scoped; create: teacher for assigned students | range validated against Hafs ayah counts |
| `GET assignments/{id}` | scoped | 404 if not visible |
| `POST assignments/{id}/start` | owning student | `not_started`/`needs_repeat` → `in_progress` |
| (any unknown or malformed `/api/` URL) | — | JSON `{code: not_found, request_id}` 404 (never an HTML page); oversized bodies → JSON 413 |
| `POST bookings/{id}/cancel` | teacher (own session), admin | **students are refused** (`excuse_instead`, 403): they send an excuse instead (owner decision 23 Oct 2026). Rescheduling keeps working |
| `POST bookings/{id}/excuse` | student (own confirmed booking) | `reason` 5–500 chars, until `excuse_deadline_minutes` (admin setting, default 60) before the start (`excuse_deadline` 409 after). One per booking; the same request twice → 200; another → `excuse_exists`. The booking is never cancelled. Bookings carry `excuse` (status; reason/response hidden from parents), `excuse_deadline`, `can_excuse` |
| `GET teacher/excuses?status=pending` · `POST teacher/bookings/{id}/excuse/approve` / `…/reject` | teacher of the session | approve (`response` optional) records attendance «غاب بعذر»; reject needs `response`. A second decision → `already_reviewed` (row lock). Audit `booking.excuse_approved/rejected` (no excuse text). Student and parents notified; lock screens show generic text |
| `POST admin/bookings/{id}/excuse/review` | admin with `excuses.review` | `{approve: bool, response}` decides a **pending** request with the same rules (reject needs `response` ≥ 3 chars; first decision wins → `already_reviewed` 409 «تمت مراجعة هذا الاعتذار بالفعل.»). Stored as `decided_by_role=admin` + `admin_response` (the teacher's fields stay theirs). Approve → «غاب بعذر»; reject never marks absence. Audit `booking.excuse_admin_approved/rejected` (decision, has_response; no text). Student, parents and the session's teacher (`excuse_decided`) are notified. `GET admin/excuses?status=pending|approved|rejected` rows carry `decided_by` (`teacher`/`admin`/`override`), `topic`, `circle`, `admin_response`. Corrections after a decision stay `excuse-override` |
| `GET admin/excuses` · `POST admin/bookings/{id}/excuse-override` · `GET admin/users/{id}/discipline` | admin | all excuses; «اعتماد العذر إداريًا» (reason required; teacher's decision kept; audit `booking.excuse_admin_override`); the student's figures, each absence and whether it counts |
| `POST admin/users/bulk-action` `{action: "delete", ids, reason, confirm: "حذف", otp, params?: {cancel_sessions}}` · `GET admin/users/{id}/delete-preflight` | admin `users.delete_permanent` (owners always; others only when granted) + a current authenticator code | Permanent delete (fixed 24 Oct). Errors: `fresh_mfa_required` «أدخل رمز التحقق الحالي من تطبيق المصادقة.», `fresh_mfa_invalid` «رمز التحقق غير صحيح…» (both 403), no permission «ليس لديك صلاحية الحذف النهائي.» (403). Per record: `upcoming_sessions` (teacher; the preflight gives the count, `cancel_sessions: true` cancels them, notifies students and continues), `storage_failed` (private files could not be removed — nothing was changed), `unexpected` (with the request id). Success: `done: [{id, label, result: {mode}}]`, and `mode` (`removed` / `anonymized`) at the top level for a single account. All database changes and the batch removal of private files (last step) form one transaction. The portal waits up to 2 minutes for bulk actions. |
| `GET teacher/integrations/google/status` · `POST …/connect` → `{auth_url}` · `POST …/disconnect` · `GET integrations/google/callback` | teacher (callback: the same signed-in teacher only) | Google Calendar connection. Scopes `openid email calendar.events`, offline access. Status `not_connected` / `active` / `reconnect_required`, masked email. Never returns tokens. |
| `POST teacher/sessions` (Idempotency-Key) · `GET/PATCH teacher/sessions/{id}` · `POST teacher/sessions/{id}/cancel` · `POST teacher/sessions/{id}/retry` · `GET/POST admin/sessions/{id}/google` | teacher (own sessions, linked students, own published circles); admin `sessions.view` / `sessions.manage` | `{student | circle, topic: hifz/review/tajweed/test/other, date, time, minutes 15–180, title?, prep_note?}`. Creates the occurrence as `pending`, then ONE Google event (HALQA-chosen event id; `conferenceDataVersion=1`, `createRequest.requestId` reused on retries, `sendUpdates=all`). 201 when the Meet is ready (bookings created, students notified), 202 while Google finishes, error `google_*` with `fields.session` for «أعد المحاولة». PATCH moves the same event (Google first; refusal rolls back). Cancel deletes the event (retried hourly if Google is down). Errors: `google_not_connected`, `google_reconnect_required` (409), `google_forbidden`, `google_rate_limited`, `google_unavailable` (502). The Meet link reaches students only via `bookings/{id}/join` inside the join window. |
| `GET admin/kpis?from&to&teacher&circle` · `GET admin/teacher-workload?…` · `POST admin/teacher-workload/export` | admin `analytics.view` (export also `exports.create`, audited `admin.export`) | «التقارير»: academy KPIs and per-teacher workload aggregated in the database. Default range: the last 30 days in the platform time zone (max one year). Ratios are `{value, num, den}` with `value: null` when there is no data; `definitions` explains every number; `not_filtered` lists metrics a chosen teacher/circle filter does not change. Overdue feedback = a recording waiting more than 48 h. |
| `GET admin/import/students` (template) · `POST admin/import/students` multipart {file, dry_run} | admin `users.create` (+ `teachers.assign` for `teacher_email`, `circles.manage` for `circle`, `users.view_contact` for `phone`) | CSV student import. UTF-8 (BOM ok), ≤1 MB, ≤500 rows; columns `full_name,email,phone,timezone,level,teacher_email,circle` (unknown or missing required columns refuse the file). `dry_run=true` (default) validates the whole file and writes nothing: each row `valid` / `duplicate` (existing account or repeated in the file) / `error` with reasons; circle seats are counted across the file. `dry_run=false` re-validates, creates each valid row in its own transaction (no password; phone saved as an unverified contact number; teacher link and circle join use the normal rules), sends setup emails within a 45 s budget (the rest are reported `pending`, marked `setup_email_status=pending` and sent by the hourly `send_pending_setup_emails`), and returns the per-row result. Audited: `admin.students_imported` (counts only) plus `admin.user_created` with `source=csv_import`. |
| `GET/POST support/tickets` · `GET support/tickets/{id}` · `POST support/tickets/{id}/messages` · `POST support/tickets/{id}/close` | student, teacher, parent (own tickets only; others 404) | «الدعم»: category (`account`, `booking`, `relationship`, `technical`, `other`; `payment` reserved), subject ≤160, message ≤4000, optional `image` (multipart; PNG/JPEG/WebP ≤5 MB, re-encoded so EXIF/location is dropped; recordings or existing media ids are refused). Writes are limited by `THROTTLE_SUPPORT` (20/hour). A reply to `waiting_user`/`resolved` reopens; closed tickets take no replies. Internal notes and the answering admin's name are never returned. |
| `GET admin/support/tickets?status&category&assignee=me|none|{id}&q` · `GET admin/support/tickets/{id}` · `GET admin/support/counts` · `GET admin/support/staff` · `PATCH admin/support/tickets/{id}` {status, assignee} · `POST admin/support/tickets/{id}/messages` {message, internal, status?, image?} | admin `support.view` (read, incl. internal notes); `support.manage` (reply, note, assign, state) | Audited: `support.ticket_created`, `support.user_replied`, `support.closed_by_user`, `support.replied`, `support.note_added`, `support.ticket_updated`. A public reply defaults the ticket to `waiting_user` and notifies the requester (`support_reply` / `support_resolved`; lock-screen text is generic). The first staff member to answer becomes the assignee if none. On account deletion the person's ticket text is blanked and screenshots deleted. |
| Absence rule | — | unexcused = confirmed + absent + no approved/pending excuse (derived, never stored). 1st and 2nd → warnings (student + parents); 3rd → `suspended` with `status_reason` «تجاوز الحد المسموح للغياب بدون عذر (3 غيابات)», tokens revoked, audit `student.auto_suspended_absence`, student/parents/admins told. Idempotent under a row lock. A correction that drops an auto-suspended student below 3 does **not** reactivate: admins are alerted (`student.absence_suspension_review`). Reactivation needs a reason and never resets history. People filter `unexcused=1|2|3` (3 = three or more) |
| `POST media/recitations` | student | multipart `file` + `duration_seconds`; type checked by declared type **and** file signature; size/duration limits; stored privately under a server-generated key. Optional `X-Upload-ID` header (8–64 letters, digits, `-`): the same student sending the same id again gets the already-stored object (200) instead of a second copy; a storage failure frees the id for the retry |
| `POST media/voice-feedback` | teacher | same rules, for a review's voice note |
| `GET media/{uuid}` | owner; assigned teacher once submitted; the student a voice note answers; admin | returns a short-lived read URL (presigned on S3/R2). Parents never get audio |
| `POST assignments/{id}/submissions` | owning student | `{media}` + `Idempotency-Key`; task → `submitted`; teacher notified |
| `GET submissions`, `GET submissions/{id}` | scoped | `?state=pending|reviewed`, `?assignment=`; includes feedback and audio URLs the caller may use |
| `POST submissions/{id}/feedback` | the student's assigned teacher | scores 1–5, `accept|repeat` (repeat needs `needs_review`), timed notes, optional voice; latest attempt only, once |
| `GET, POST bookings` | list: scoped; create: student | create needs `Idempotency-Key` header; `occurrence` is a session id **or a computed slot token**; `?when=upcoming|past`, `?status=` |
| `GET bookings/{id}` | scoped | |
| `POST bookings/{id}/cancel` | owner (outside cancel window), session teacher, admin | idempotent; the student is notified when someone else cancels |
| `POST bookings/{id}/reschedule` | owner | atomic: new booking + cancel old, or nothing |
| `POST bookings/{id}/attendance` | session teacher, after start | audited |
| `GET quran/source`, `GET quran/surahs`, `GET quran/surahs/{n}?from&to` | signed in | verbatim text from the active verified source; `503 quran_unavailable` if none |
| `GET quran/audio/{surah}?reciter={id}` | signed in | ayah audio URLs from Quran Foundation (Quran.com) for one of the offered reciters (`settings/public` → `ayah_audio.reciters`, `default`); another id → 400; cached a day per reciter |
| `GET lessons`, `GET lessons/{id}`, `POST lessons/{id}/complete` | learning users (complete: student) | published lessons of published courses; completion is self-reported |
| `GET tests`, `GET tests/{id}` | student | open, published tests; questions never include answer keys |
| `POST tests/{id}/attempts` | student | starts or resumes; enforces `max_attempts`, sets the deadline |
| `POST attempts/{id}/submit` | owner | all answers at once; objective questions graded on the server; keys revealed only after submission (if the test releases results); idempotent; 2-minute grace after the deadline |
| `GET attempts/{id}` | scoped (owner, teacher, linked parent, admin) | |
| `GET teacher/grading`, `POST answers/{id}/grade` | the student's teacher | recitation / short answers; points 0..question points |
| `GET notifications`, `POST notifications/read` | signed in | own only |
| `POST invitations` | admin (any purpose); teacher (`student_teacher` only) | `{purpose, email, days?, student?, share_link?}`: issues a one-time code and **emails** the link; answers `{id, status, email_status, email_sent, expires_at, …}` without the code or link; `share_link: true` (to also send it over WhatsApp) returns `link` once. `409 email_taken` / `account_inactive` / `already_invited` (with the open invitation's id) |
| `GET invitations?open=1&purpose=` | admin (all), teacher (own) | status only (`pending`, `failed`, `expired`, `accepted`, `revoked`); never codes |
| `POST invitations/{id}/resend`, `POST invitations/{id}/revoke` | admin or the inviter | resend issues a new code (the old one stops working) with a fresh expiry and emails it; `429 too_soon` within a minute |
| `GET corrections?student&status&category&surah&submission&booking&open=1&recurring=1` | scoped (own student, assigned teacher, linked parent) | learning points at an ayah; `times` = how often the same category recurred at that ayah; parents get category, reference, priority, status and dates only (no note, guidance or internal note); `internal_note` only for teachers |
| `POST corrections` | the student's teacher | `source` submission/session/task/review with a matching link (the submission, booking or task must belong to that student; a booking must be the teacher's); ayah checked against the surah; audited; the student is notified (`correction_new`, generic push text) |
| `GET, PATCH corrections/{id}` | read scoped; edit by the student's teacher | `status` new/improving/corrected sets or clears `resolved_at`; `correction.resolved` / `correction.reopened` audited |
| `POST corrections/{id}/follow-up` | the student's teacher | `kind` ayah/tajweed/rerecord, `days` 1–14: creates one practice task for that ayah (the review scheduler is unchanged) |
| `GET corrections/summary?student`, `GET corrections/categories` | scoped | open/new/improving/corrected, recurring, by category, 8-week trend; never a score |
| `GET teacher/corrections/overview`, `GET admin/corrections/summary` | teacher / admin | students with open points, repeated memorization and Tajweed points, awaiting re-check; admin: aggregate counts only |
| `GET, POST admin/users` | admin | filters `role,status,q,unlinked=1` and the advanced filters below; `sort`; created users set their password via recovery |
| `POST admin/users/{id}/promote-teacher` | admin | Student → Teacher for ONE account (no bulk, no other role change): body `reason` (3+ chars), `confirm: "ترقية"`, `approve` (default false). Same id, email, password and history; ends active teacher links, circle memberships, future bookings («تمت ترقية الحساب إلى معلم»), guardian links to the account, active enrollments and review plans; creates an unapproved TeacherProfile unless `approve`; revokes tokens and sessions; emails the user (no password); audit `admin.user_promoted_to_teacher` with reason and counts. Teacher/parent/admin/archived/deleted → refused |
| `POST admin/users/{id}/status` | admin | `pending/active/suspended/archived`; suspension and archiving require a reason and revoke tokens |
| `POST admin/{resource}/bulk-action` | admin | bulk actions, below |
| `POST admin/teacher-assignments`, `POST admin/teacher-assignments/{id}/end` | admin | |
| `POST admin/guardian-links`, `POST admin/guardian-links/{id}/revoke` | admin | |
| `POST admin/mfa/setup`, `POST admin/mfa/confirm` | admin | TOTP (RFC 6238) |
| `POST admin/auth/login` `trust_device: true` | admin (web) | with a correct code: sets the HttpOnly cookie `halqa_admin_trusted`; for 30 days that browser signs in with the password only (audit `auth.mfa_trusted_device`). Ends on expiry, removal, password change or authenticator change |
| `GET/DELETE admin/trusted-devices`, `POST admin/trusted-devices/{id}/revoke` | admin (own devices only) | list (label from the User-Agent, last used, expiry, `current`) / remove all / remove one; audit `auth.device_trusted`, `auth.devices_untrusted` |

## Admin lists: search, filters, sort, bulk actions

Every admin list takes `q` (name, email, phone or title; a number also matches the record id), `page`, `page_size`
(max 100) and `sort` (`key` ascending, `-key` descending). Filter values are validated (`invalid_filter`, 400); dates
are Cairo calendar days `YYYY-MM-DD`.

| List | Filters | Sort keys |
| --- | --- | --- |
| `admin/users` | `role`, `status` (archived only when asked for), `joined_from/to`, `active_from/to` (last sign-in), `approved`, `has_students`, `has_slots`, `circle`, `teacher`, `level`, `upcoming`, `overdue_review`, `linked`, `unlinked`, `course` (active enrollment: a course cohort) | `name`, `email`, `joined`, `last_login`, `status` |
| `admin/circles` | `state`, `teacher`, `level`, `has_upcoming`, `created_from/to` | `name`, `updated`, `created`, `capacity`, `state` |
| `admin/bookings` | `when` (`upcoming`/`past`/`all`), `status`, `attendance` (incl. `unmarked`), `teacher`, `student`, `circle`, `kind`, `from/to` | `starts`, `student`, `teacher`, `status`, `created` |
| `admin/courses` | `state`, `teacher`, `topic`, `level`, `created_from/to` | `title`, `created`, `updated`, `state` |
| `admin/tests` | `state`, `course`, `teacher` (author), `level`, `created_from/to` | `title`, `created`, `updated`, `state` |
| `admin/courses/{id}/enrollments` | `status`, `q` | `created`, `student` |

**`POST admin/{resource}/bulk-action`**: one request per bulk action, never one request per record.

```json
{"action": "suspend", "ids": [3, 4, 9], "reason": "…"}
{"action": "suspend", "filter": {"role": "student", "status": "active"}, "expected": 235, "exclude_ids": [7], "reason": "…"}
```

Response: `{"requested": 25, "success": 23, "skipped": 1, "failed": 1, "results": [{"id", "label", "outcome", "code", "message"}], "errors": [...]}`.
`skipped` = already in that state; `failed` = refused (protected history, wrong state, not found).

- **ids** (≤ 500) or **filter** (the same validated filter as the list, ≤ 5,000 matches). In filter mode `expected`
  must equal the current number of matches (minus `exclude_ids`); otherwise `409 results_changed` with the new count,
  and nothing changes.
- Each record runs in its own transaction: a failure rolls back that record only.
- Destructive actions on 10 or more records need `"confirm": "حذف"` (`400 confirm_required`).
- One audit event per request: `admin.bulk_<action>` with resource, mode, counts, affected ids, filter and reason.

| Resource | Actions | Never |
| --- | --- | --- |
| `users` (students, teachers, parents) | `activate` (also restores archived), `suspend`*, `archive`* (soft delete), `approve`, `unapprove`* (teachers only), `assign_teacher`† (students), `move_to_circle`† (students), `enroll`† (students), `notify`†, `resend_setup`, `delete`* (permanent; always needs `confirm: "حذف"`: an account with no activity is removed; otherwise personal data is erased — name «حساب محذوف», placeholder email, no phone/password/MFA, recordings and voice notes removed from storage, tokens/notifications/bookmarks deleted, links, memberships and future bookings ended — and educational records stay anonymous; a teacher with upcoming sessions is refused; audit `admin.user_deleted` with id, role and mode only) | admins are never targets; deleted accounts are hidden from every admin list and endpoint and can never be reactivated |
| `circles` | `publish`, `disable`*, `draft`, `delete` (draft with no sessions) | delete with sessions |
| `sessions` | `cancel`* (future only; bookings cancelled, students notified) | delete |
| `bookings` | `cancel`* (future only; student notified) | delete; past bookings and attendance |
| `courses` | `publish`, `draft`, `archive`*, `delete` (draft with no lessons, enrollments or quizzes) | delete with history |
| `lessons` | `publish`, `draft`, `archive`, `delete` (draft nobody completed, no task points to it) | delete with completions |
| `enrollments` | `withdraw`, `complete` | delete |
| `tests` | `publish`, `close`, `draft`, `delete` (draft nobody attempted) | delete with attempts |
| `questions` | `remove` (retired: answers keep pointing at it) | hard delete |

\* requires `reason` (3+ characters). No bulk endpoint exists for the audit log, the Quran text, recordings or notifications.

† takes `params`, validated once before any record is touched (`400` with a field error otherwise):

| Action | `params` | Rules |
| --- | --- | --- |
| `move_to_circle` | `circle` (id) | the circle must be published; joins it (booked into every upcoming session) and leaves the student's other circles (their future bookings cancelled); full circle → refused (`circle_full`) |
| `assign_teacher` | `teacher` (id), `replace` (bool) | teacher must be active and approved; suspended/archived students refused; already linked → skipped; `replace` ends the student's other active teachers |
| `enroll` | `course` (id) | not an archived course; suspended/archived students refused; already actively enrolled → skipped |
| `notify` | `title` (3–80), `body` (3–500) | in-app message (`admin_message`); the phone's lock screen shows only the generic text; suspended/archived skipped as refused; the audit event keeps the title and counts, not the body |
| `resend_setup` | — | needs SMTP (`409 email_off`); only accounts without a password; at most once per 10 minutes per account (`recently_sent` → skipped); the link is emailed, never returned or logged |

**Circle members** (owner decision 20 October 2026): `GET admin/circles/{id}/members` (`?all=1` includes past
members), `POST admin/circles/{id}/members {student}`, `POST admin/circle-members/{id}/end {reason?}`. A member is booked
into every upcoming session of the circle (no per-session notification; one «انضممت إلى …»). Joining needs a published
circle and a free seat (active members < capacity, checked under a lock); capacity cannot drop below the member count.
New circle sessions book members at once (`members_booked`), and the hourly job `sync_circle_members` fills gaps.
A session the student cannot attend (another booking at that time) or a full session is skipped and reported.
Leaving cancels only future bookings in that circle; past bookings and attendance stay.

**`POST admin/{resource}/export`** (`users`, `circles`, `bookings`, `sessions`, `courses`, `lessons`, `enrollments`, `tests`):
the same `ids` or `filter` (+ `exclude_ids`, `sort`) as a bulk action, up to 20,000 rows. Answers `text/csv` (UTF-8 with
BOM, Cairo times, Arabic headers). Names, dates, states and counts only: no tokens, media URLs, private notes or
the student's booking note. Cells starting with `= + - @` are prefixed with `'` (formula injection). Audited as
`admin.export` (resource, mode, rows, filter).

**`GET, POST admin/saved-views`, `DELETE admin/saved-views/{id}`**: an admin's own named presets for a list section
(`students`, `teachers`, `parents`, `circles`, `bookings`, `lectures`, `quizzes`, …). The query string is validated
with that list's filter rules before it is stored; up to 30 per admin; other admins cannot see or delete them.

## Admin accounts and permissions («الإدارة والصلاحيات»)

Every admin has an access level: **owner** (every permission) or **admin** (exactly the permissions granted). The
granted set comes from a preset (مدير أكاديمي، خدمة العملاء، إدارة المحتوى، مسؤول الجلسات، مشاهدة فقط) or a custom
choice. The registry and presets live in `backend/apps/accounts/admin_access.py`. Every admin endpoint declares what
it needs (`admin_perm`), and `IsAdminRole` refuses anything undeclared. An admin account without a profile has no
access. A refusal is **403 `admin_permission_denied`** with `fields.permission`. `GET me` returns `admin_access`
(`level`, `preset`, `permissions`), and the portal shows only the sections and buttons those permissions allow.

**`GET admin/admins`** (`admins.manage`): admins (phones masked without `users.view_contact`), open admin
invitations, the permission names with Arabic labels, and the presets.

**`POST admin/admins`** `{full_name, email, level, preset, permissions?, otp}`: emails a one-time invitation, subject
«دعوة للانضمام إلى إدارة حَلْقة». It expires after 3 days and is bound to that email address; a new invitation
replaces the open one. The invitee accepts at `#/invite?code=…&kind=admin` and must turn on two-step verification at
their first portal sign-in.

**`PATCH admin/admins/{id}`** `{level, preset, permissions?, otp}` changes an admin's access. It applies from that
admin's next request.

**`POST admin/admins/{id}/status`** `{status: suspended|active, reason, otp}` suspends or reactivates an admin.
Suspending ends their sessions.

**Teacher + admin on one account** (owner request, 24 Oct 2026). Admin access comes from `AdminProfile`, never from the role (`admin_access.has_admin_access`): an active account whose profile is active (`AdminProfile.is_active`), or a traditional `role=admin` account (no profile → no permissions). A teacher keeps `role=teacher` and is an admin **only** through the admin portal's own session (`X-Halqa-Portal: admin` cookie session from `POST admin/auth/login`, two-step verification always required for them); the teacher app's session/token never passes `IsAdminRole`, and the native admin login refuses them. In the portal context shared code uses `acts_as_admin(user)`; `me.admin_access` carries `active` and `teacher_admin`.
- **`GET admin/admins/teacher-candidates?q=`** (`admins.manage`): active teachers without admin access, by name/email/phone.
- **`POST admin/admins/grant-teacher-access`** `{teacher, level, preset, permissions?, otp}` (`admins.manage`, fresh MFA, owner level by owners only, never beyond the granter's own permissions): adds the profile; nothing of the teacher's changes. Audit `admin.access_granted_to_teacher`; the teacher is notified (`admin_access_granted`, no password link).
- **`POST admin/admins/{id}/access`** `{action: suspend|reactivate|remove, reason, otp}` (teacher-admins only; reason ≥ 3 except reactivate; never oneself; owners by owners; never the last active owner): pauses (`is_active=false`), resumes or deletes the profile. The portal session is refused from the next request and trusted admin browsers are forgotten; the teacher app is untouched. Audit `admin.access_suspended / access_reactivated / access_removed_from_teacher`.
- `GET admin/admins` lists teacher-admins too (`teacher_admin`, `access_active`). `POST admin/admins/{id}/status` refuses them (`teacher_admin` 409). Inviting an email that belongs to a teacher → `teacher_exists` 409 «هذا البريد يخص معلمًا موجودًا. يمكنك منحه صلاحيات الإدارة من حسابه الحالي.» (`fields.user`); nothing is emailed.
- People pages: suspending/archiving a teacher-admin's account needs `admins.manage` (`admin_holder`), and permanent delete is refused until admin access is removed.

Rules, enforced on the server:
- Nobody changes their own access.
- Only an owner creates, edits or suspends an owner.
- Nobody grants a permission they don't hold.
- There is always at least one active owner (409 `last_owner`).

**Fresh MFA:** inviting, editing or suspending an admin, and permanent delete (`users` bulk action `delete`), need a
current authenticator code in `otp` (403 `fresh_mfa_required`), even inside a signed-in session.

**Audit events:**
- `admin.invited`, `admin.setup_completed`, `admin.mfa_enabled`.
- `admin.permission_changed` (with `added` and `removed`).
- `admin.preset_changed`.
- `admin.suspended`, `admin.reactivated`.

Bulk actions map to permissions in `admin_access.USER_ACTIONS` and `BULK_WRITE`. Exports need `exports.create`, the
list's read permission, and, for people, `users.view_contact`.

## Permission matrix (learning records: assignments, bookings, feedback)

| Role | Can read | Can write |
| --- | --- | --- |
| Student | own | start own tasks, book/cancel/reschedule own sessions |
| Teacher | students with an active `TeacherAssignment`; own sessions' bookings | assignments for assigned students; attendance for own sessions; cancel own sessions' bookings |
| Parent | children with an **active** `GuardianLink` (read-only) | — |
| Admin | what their permissions allow (see «Admin accounts and permissions») | the same; all changes audited |

Objects outside your scope return **404** (not 403), so IDs can't be probed.

## Status transitions

Assignment: `not_started → in_progress → submitted → accepted | needs_repeat`;
`needs_repeat → in_progress | submitted`. Every change is stored in `AssignmentEvent`
with the actor.

Booking: `confirmed → cancelled`. Attendance is set separately on confirmed bookings:
`present | late | absent | excused`.

## Integrity guarantees (PostgreSQL)

- Teacher sessions cannot overlap (`EXCLUDE USING gist` on `tstzrange`, cancelled excluded).
- One confirmed booking per student per session (partial unique index).
- Booking creation is idempotent per `(student, Idempotency-Key)`.
- Capacity and student-overlap checks run inside the booking transaction, under a row
  lock on the session and an advisory lock per student. Tested with concurrent requests.
- Feedback scores are 1–5; a "repeat" decision must say what needs review.
- Ayah ranges are valid (`from ≥ 1`, `to ≥ from`, surah 1–114).
- `PROTECT` foreign keys keep teaching history when users are archived.


## Teacher availability (24 h ranges; owner request, 25 Oct 2026)

Teachers are not limited to fixed times. Availability is a set of **ranges** anywhere in 00:00–23:59 (academy
timezone, `AppSettings.default_timezone`, Africa/Cairo by default); an end at or before the start runs past midnight
(«22:00 → 02:00»). Nothing is pre-created: bookable start times are computed on request (`scheduling/availability.py`):

    (weekly ranges − dates closed) + extra ranges for a date − blocked time − the teacher's real sessions ± `session_buffer_minutes`
    − Google Calendar busy time (when connected; HALQA's own events, free/transparent and all-day events ignored)
    − outside the booking window (`booking_lead_minutes` … `booking_horizon_days`)

stepping every `slot_increment_minutes` (15 default, or 30) and keeping only sessions that end inside their range.
Wall-clock times are converted with zoneinfo and compared in UTC; a time skipped by DST is never offered.

Booking a token (`POST bookings`, `POST bookings/{id}/reschedule`) re-checks the exact time on the server under a
per-teacher advisory lock, checks Google live (an unreachable Google never blocks: last known answer), then creates the
session; the exclusion constraint `teacher_no_overlapping_sessions` is the final guard. Free rows of the old fixed-slot
generator (from a weekly rule, nobody holding them) do not count as busy and are closed when a booking needs their
time; booked sessions are never changed.

| Endpoint (teacher: `teacher/availability…`; admin: `admin/teachers/{id}/availability…`) | Notes |
|---|---|
| `GET …` | `timezone`, `tz_offset`, `increment`, `durations`, `default_minutes`, `gap_minutes`, `rules[]` (`weekday` 0=Monday…6=Sunday, `start`, `end`, `session_minutes`, `overnight`) |
| `POST …/rules` `{weekday, start, end, session_minutes}` | «إضافة فترة إتاحة». Refused: invalid/off-grid time, zero length, shorter than the session, a length not in `session_durations`, an overlap with any range on the weekly circle (including an overnight range reaching the next day; duplicates). Adjacent ranges are allowed |
| `PATCH …/rules/{id}` · `DELETE …/rules/{id}` | edit / delete; sessions already booked keep their time |
| `POST …/copy` `{from_weekday, to_weekdays[]}` | «نسخ لأيام أخرى» / «نسخ لهذا الأسبوع»: the chosen days get exactly the source day's ranges; all or nothing (`overlap` 409) |
| `GET …/overrides?from=&to=` · `POST …/overrides` `{date, kind: off\|extra\|blocked, start?, end?, session_minutes?, reason?}` · `DELETE …/overrides/{id}` | «تعديل هذا اليوم فقط»: close the date, add a range that date, «حظر وقت». Today … one year. The reason is private (never in slots or audit) |
| `GET …/day?date=` | the day as the teacher sees it: `weekly`, `overrides`, `closed`, `timeline[]` (`available` / `booked` / `unavailable` / `calendar`), `sessions[]` (with student names / circle), `bookable_starts` |

Admin access: view `teachers.view`, change `sessions.manage`. Audit: `teacher.availability_changed` (teacher) /
`teacher.availability_admin_changed` (admin), with the operation and times only. Settings (`admin/settings`):
`slot_increment_minutes` (15|30, «الفاصل الزمني للمواعيد»), `session_durations` (default `[30, 45, 60]`),
`session_buffer_minutes` (0–120).

## Teacher titles (owner request, 25 Oct 2026)

Every teacher's name is shown with its Arabic title — «الشيخ» (male) / «الأستاذة» (female) — wherever it appears:
screens, notifications, exports, admin tables. It is presentation only:
- `User.gender` (`male` / `female` / empty) decides the title; empty → the plain name (no guessed title).
- `full_name` is stored plain. Titles typed into a teacher's name are removed on save (`PATCH me`, admin edit,
  teacher creation), and removed again when shown (`الشيخ/الأستاذة/أستاذ/الشيخ/الشيخة/أ.` at the start), so a title
  is never doubled.
- One formatter on each side: `apps/accounts/display.py` (`User.display_name`; used for `teacher_name`, `teacher.name`,
  notification texts, exports) and `src/lib/names.ts` (`formatTeacherName`, `nameOf`) for raw user objects in the app.
- `display_name` and `gender` are returned by `me`, `teachers`, admin users and admin lists; editable fields stay `full_name`.
- Only `role = teacher` accounts get a title (students, parents and admin-only accounts never).
- Setting it: the teacher in «حسابي → اللقب»; an admin in the teacher's profile («اللقب», `users.edit`); required when an
  admin creates a teacher (`POST admin/teachers {gender}`).

## Web Push (production, 26 Oct 2026)

- `/api/ready` → `features.push`: `ready` only when both VAPID keys are set **and** the private key derives the public
  key; `misconfigured` (keys do not belong together) or `not_configured`. Keys come from `deploy/gcp-push.sh` (private
  key in Secret Manager `halqa-vapid-private`; the public key is a plain setting); the admin service and the hourly job
  copy them on every deploy.
- `GET push/config[?endpoint=]` → `enabled`, `status`, `public_key` (only when ready), `this_device` (this endpoint is
  registered **and active** for this account), `this_device_inactive`, `devices` (active).
- `POST push/subscriptions` (one row per browser endpoint; registering again re-activates it and clears failures; an
  endpoint used by another account on a shared browser moves) · `DELETE push/subscriptions {endpoint}` (this device only).
  `POST auth/logout {push_endpoint}` removes only the signing-out device.
- Delivery (`notifications.push`): every in-app notification is pushed to the recipient's **active** devices if the
  category is on (`notify_prefs`; account alerts always). Lock-screen text is generic per kind; the payload is only
  `{title, body, url:"/#/n/<id>", tag}` — the app opens that notification for the signed-in account (`GET notifications/<id>`,
  own only) exactly as the inbox does. The service worker accepts only `/#/n/<id>` or `/#/inbox`.
- Failures: 404/410 → the subscription is deleted; 401/403 (other keys) → switched off at once; other errors count
  up and switch the device off after 5 in a row. Rows keep `last_success_at`, `last_failure` (category) and
  `last_failure_at`; logs `push_sent` / `push_failed` / `push_endpoint_removed` carry category and device family only.
- Admin (`notifications.send`): `GET admin/users/{id}/push-devices` (active, family, created, last success, last failure
  category — never the endpoint, keys or user agent) · `POST admin/users/{id}/push-test` «إرسال إشعار تجريبي»: the fixed
  text «الحلقة / هذا إشعار تجريبي للتأكد من عمل الإشعارات.» to the person's active devices; 1 per person per minute,
  10 per admin per hour; audited `admin.push_test` (counts only).
- Ops task `push-report` (read-only): key check, devices by role/family, deliveries/failures, and push requests/results
  from the logs.
