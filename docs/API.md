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
- While waiting, the teacher chooses their Qira'at (`PUT teacher/riwayat`, at least one). Approving the teacher confirms that choice (see «Qira'at qualifications»).
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
| `GET teachers`, `GET teachers/{id}` | learning users | approved, active teachers; `?q=`, `?tag=`, `?riwayah=<code>` (a confirmed Riwayah; unknown code → 400). Each teacher has `riwayat_qualifications` (confirmed only). See «Qira'at qualifications» below |
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
| `GET quran/index` | signed in | the 114-surah index for pickers; see «Quran references» below |
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
| `GET, PATCH corrections/{id}` | read scoped; edit by the student's teacher | `status` new/improving/corrected sets or clears `resolved_at`; `correction.resolved` / `correction.reopened` audited. `surah` + `ayah` can be edited, validated as a pair (a new surah needs its ayah); the audit records `old_ref` / `new_ref` |
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

Every teacher's name is shown with its Arabic title — «الأستاذ» (male) / «الأستاذة» (female) — wherever it appears:
screens, notifications, exports, admin tables. It is presentation only:
- `User.gender` (`male` / `female` / empty) decides the title; empty → the plain name (no guessed title).
- `full_name` is stored plain. Titles typed into a teacher's name are removed on save (`PATCH me`, admin edit,
  teacher creation), and removed again when shown (`الأستاذ/الأستاذة/أستاذ/الأستاذ/الأستاذة/أ.` at the start), so a title
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
- Ops task `push-report` (read-only): key check, devices by role/family, deliveries/failures, switched-off devices
  and their last failure categories, the last 10 «إرسال إشعار تجريبي» presses (`admin_tests_7d`: time, target id,
  devices/sent/failed), and push and admin push-test requests/results from the logs.

## Quran references: surah/ayah pickers (owner request, 27 Oct 2026)

- **`GET quran/index`** (signed in) → `{source, verified, surahs: [{number, name_ar, ayah_count}] ×114}` in Mushaf order.
  - Names come from the active verified Tanzil import (`quran-data.xml`).
  - Counts come from `HAFS_AYAH_COUNTS`, which the import is checked against.
  - Works before the text is imported: names are then empty and pickers show numbers.
  - `verified` is true when the stored source has every name and the canonical count for every surah.
- **One validator** (`apps/quran/reference.validate_ref`): the surah must be 1–114 and the ayah must exist in that surah.
  - Field errors are in Arabic and name the surah and its range, e.g. «سورة الفاتحة تحتوي 7 آية فقط؛ اختر آية من 1 إلى 7.».
  - Used by `POST corrections` and by `PATCH corrections/{id}`, which may change `surah` + `ayah` together.
- **Stored identifiers:** references are stored as numbers (`surah`, `ayah`), never names.
- **App formatter:** `src/lib/quranIndex.formatRef` gives «البقرة — الآية 255», or compact «البقرة · 255».
- **Ops `verify-quran`** also runs `check_quran_reference --metadata quran-data.xml` (read-only). It checks:
  - all 114 surahs are present, with the canonical counts and stored ayahs;
  - every surah has a name, and the names equal Tanzil's metadata;
  - no saved mistake, task, bookmark or reading position points at an ayah that does not exist (reported, never changed).

## Qira'at qualifications «القراءات والروايات» (owner request, 2 Nov 2026)

**Reference data.** Migration `accounts 0015_qiraat` adds two tables, seeded from `apps/accounts/qiraat.py` (`CANON`):
- `Qiraah` (`code`, `name_ar`, `order`): the ten Qira'at in classical order.
- `Riwayah` (`code`, `qiraah`, `name_ar`, `narrator_ar`, `order`): two primary narrators each, 20 in all.
- The codes are the identities; the Arabic text is display only:

| Qiraah | Riwayat |
|---|---|
| `nafi` نافع المدني | `qalun` قالون عن نافع · `warsh` ورش عن نافع |
| `ibn_kathir` ابن كثير المكي | `bazzi` البزي عن ابن كثير · `qunbul` قنبل عن ابن كثير |
| `abu_amr` أبو عمرو البصري | `duri_abu_amr` الدوري عن أبي عمرو · `susi` السوسي عن أبي عمرو |
| `ibn_amir` ابن عامر الشامي | `hisham` هشام عن ابن عامر · `ibn_dhakwan` ابن ذكوان عن ابن عامر |
| `asim` عاصم الكوفي | `shubah` شعبة عن عاصم · `hafs` حفص عن عاصم |
| `hamzah` حمزة الكوفي | `khalaf_hamzah` خلف عن حمزة · `khallad` خلاد عن حمزة |
| `kisai` الكسائي | `abu_harith` أبو الحارث عن الكسائي · `duri_kisai` الدوري عن الكسائي |
| `abu_jafar` أبو جعفر المدني | `ibn_wardan` ابن وردان عن أبي جعفر · `ibn_jammaz` ابن جماز عن أبي جعفر |
| `yaqub` يعقوب الحضرمي | `ruways` رويس عن يعقوب · `rawh` روح عن يعقوب |
| `khalaf` خلف العاشر | `ishaq` إسحاق عن خلف · `idris` إدريس عن خلف |

A teacher's qualifications are `TeacherRiwayah` rows (`teacher`, `riwayah`, `verified_at`, `verified_by`): one per
teacher + Riwayah. Learners only ever see rows with `verified_at`.

**Endpoints**
- `GET qiraat` (signed in) → `[{code, name, order, riwayat: [{code, name, narrator, order}]}]`.
- `GET teacher/riwayat` · `PUT teacher/riwayat {riwayat: [...]}` (teacher, own) → `{riwayat: [{code, name, qiraah, qiraah_name, verified}]}`.
  - Items are codes (`"hafs"`) or pairs (`{"qiraah": "asim", "riwayah": "hafs"}`); a pair's Qiraah must be the Riwayah's own.
  - At least one is required.
  - Refused with `400`, field `riwayat`: free text, unknown codes, duplicates, a Riwayah under the wrong Qiraah, not a list.
  - An addition waits for the admin (`verified: false`). A removal applies at once.
  - Audited as `teacher.riwayat_updated` (`added`, `removed`).
- `GET admin/teachers/{id}/riwayat` (`teachers.view`) · `PUT admin/teachers/{id}/riwayat {riwayat}` (`teachers.approve`).
  - `PUT` sets the confirmed list exactly; it may be empty.
  - Audited as `admin.teacher_riwayat` (`before` with `?` marking unconfirmed, `after`).
- `GET admin/users/{id}` → `riwayat`: all rows with `verified` for teachers, `null` for other roles.
- Approving a teacher (`POST admin/teachers/{id}/approval`, or bulk `approve`) confirms the Riwayat they chose.
  `admin.teacher_approval` records `riwayat_confirmed`.
- `GET teachers`, `GET teachers/{id}` → `riwayat_qualifications: [{code, name, qiraah, qiraah_name}]` (confirmed only).
  `?riwayah=<code>` filters on a confirmed one.

**Existing teachers.** Nothing is assumed: their list is empty, they stay listed and bookable, and both the teacher
and the admin are asked to «أضف القراءات والروايات».

## Daily Quran reminders «تذكيرات القرآن الكريم» (owner request, 4 Nov 2026)

- `GET me/reminders` · `PUT me/reminders` (students): `{reading_on, reading_hour, hifz_on, hifz_hour, review_on,
  review_hour, evening_on, evening_hour, quiet_start, quiet_end}` plus read-only `timezone` and `enabled`.
  - Hours are 0–23 in the student's `timezone`.
  - A reminder hour inside the quiet hours is refused (`400`, field `<kind>_hour`).
  - The category on/off is `notify_prefs.reminders` (`PATCH me`).
- **Sending:** `quran_reminders` (hourly job) creates notifications of kind `reminder_reading` / `reminder_hifz` /
  `reminder_review` / `reminder_evening`, with dedupe key `reminder:<kind>:<local date>`.
  - Only to active students with an active push device.
  - Within 2 hours after the chosen hour; one per student per run; none in quiet hours.
  - Only with something left to do: reading skipped once the reading position was saved today; memorization needs
    an open memorization task; review needs a review task due by today; end of day needs a task due today, not done.
- **Lock screen:** generic text only. `data`: `{"screen": "mushaf"}` or `{"assignment": id}`, which the app opens.

## Preferred-teacher requests «اختر معلمك» (owner request, 4 Nov 2026)

- **Student endpoints:**
  - `GET student/teacher-request` → `{has_teacher, request}`.
  - `POST student/teacher-request {teacher | suggested_name, note?}`: exactly one of an approved, active teacher or
    a name of at least 3 characters.
  - Refused: a student who already has a teacher (`409 has_teacher`), a second pending request
    (`409 duplicate_request`, also a database constraint).
- **Statuses:** `pending` بانتظار المراجعة, `approved` تمت الموافقة, `unavailable` المعلم غير متاح,
  `assigned` تم تعيين المعلم. A request never assigns a teacher by itself.
- **Admin endpoints:**
  - `GET admin/teacher-requests?status=open|pending|approved|unavailable|assigned` (`teachers.view`): student,
    requested teacher or suggested name, date, status, alternative, assigned teacher, notification `history`.
  - `POST admin/teacher-requests/{id}/decide {action, teacher?, note?}` (`teachers.assign`):
    - `approve`: pending only.
    - `unavailable`: with an optional alternative teacher, named in the student's notification.
    - `assign`: the given, requested or alternative teacher, through a normal `TeacherAssignment`.
  - Audited as `admin.teacher_request_decided` and `admin.teacher_assigned`. The student is notified on each
    change (`teacher_request_<status>`).
- **Any assignment** (the request, the student record, a bulk action) closes the open request as `assigned` and
  marks unread «اختر معلمك» reminders read (`TeacherAssignment` post-save).
- **Reminder** (`teacher_reminders`, hourly job): for students with no active teacher, every
  `AppSettings.teacher_reminder_hours` (default 48, 0 = off, at most 336), never while one is unread.
  - `teacher_pick` «اختر معلمك», or `teacher_pick_pending` «طلبك قيد المراجعة» while a request is pending or approved.
  - In-app (and push to the student's devices if «تذكيرات القرآن واختيار المعلم» is on). Never on login.


## Adhkar «الأذكار والأدعية» (owner request, 13 Nov 2026)

Content rule: Quran and authentic Sunnah only (hadith graded صحيح or حسن), each entry with its source. Nothing is
shown or sent until an administrator approves it. Quranic text is never typed: the server copies it from the active
verified Quran source (Tanzil import) by surah and ayah numbers.

**Readers (every role, signed in):**
- `GET adhkar?category=&q=&favorites=1` → `{categories: [{key,label,count}], results: [Dhikr]}`.
  - Only approved, enabled entries.
  - `q` ignores Arabic diacritics.
- `GET adhkar/<id>` → one Dhikr (404 if not approved or disabled).
- `POST | DELETE adhkar/<id>/favorite` → `{favorite}`.
- `GET | PUT me/adhkar-settings` → `{enabled, interval_hours (0 off | 1 | 2 | 3 | 4), window_start, window_end,
  morning_on, morning_hour, evening_on, evening_hour, sleep_on, sleep_hour, quran_dua_on, sunnah_dua_on, quiet_start,
  quiet_end, timezone}`.
  - Hours are 0–23 in the account's IANA `timezone` (defaults to Africa/Cairo).
  - Defaults: on, every 2 hours from 08:00 to 22:00, morning 07:00, evening 17:00, sleep 22:00, quiet hours 23:00–06:00.
  - Turning these off never affects learning or administrative notifications.
- **Dhikr fields:** `id, category, category_label, text, source_type (quran|hadith), source` («البقرة: ٢٠١» /
  «صحيح مسلم (٢٦٩١) · صحيح»), `repetition` (null unless the source states a number), `time_of_day, time_label, surah,
  ayah_from, ayah_to, hadith_collection, hadith_number, grading, grading_label, graded_by, reference_url, favorite`.

**Administration** (permissions `adhkar.view`, `adhkar.manage`, `adhkar.approve`; the «إدارة المحتوى» preset has
view and manage; owners have all):
- `GET admin/adhkar?status=&category=&source=&q=&page=` → paginated (100 per page) `{counts, categories, rows}`.
- `POST admin/adhkar` creates a **pending** entry.
  - Quran: `{source_type: "quran", category, surah, ayah_from, ayah_to}`. Text comes from the verified source;
    `400` if those ayahs do not exist; `409` if they are already in the library.
  - Hadith: `{source_type: "hadith", category, text, hadith_collection, hadith_number, grading (sahih|hasan),
    graded_by?, reference_url?}`.
  - Optional for both: `repetition`, `time_of_day (any|morning|evening|sleep|waking)`.
- `PATCH admin/adhkar/<id>`: a change to the text or source sends the entry back to pending.
- `POST admin/adhkar/<id>/review {decision: approve|reject, note}` (`adhkar.approve`). Rejecting requires a note.
- `POST admin/adhkar/<id>/enable {enabled}`.
- `POST admin/adhkar/seed-quran` («إضافة المحتوى الموثّق») adds, as pending:
  - the proposed Quranic references: about 90 whole-ayah duas, istighfar, tasbih, and verses on the virtue of the
    Quran;
  - the Sunnah entries in `apps/adhkar/data/sunnah_adhkar.json` (36): morning, evening, sleep, waking, istighfar,
    tasbih, salawat, prophetic duas, and hadiths on the virtue of the Quran.
- **How the Sunnah file is built** (`python -m apps.adhkar.sunnah_build <dir>`, run by a developer):
  - Source: the public-domain hadith dataset github.com/fawazahmed0/hadith-api (Unlicense).
  - Each text is copied verbatim from the narration, between search markers (`sunnah_refs.py`), diacritics included.
  - Bukhari and Muslim are graded صحيح. The Sunan need al-Albani's grade in the dataset to be Sahih or Hasan.
  - Refused automatically: a span containing a narrator's words, a corrupted character, or a marker not found.
  - Muslim numbers follow Fuad Abdul-Baqi's numbering.
- **Ops `adhkar-library`** (production) runs `load_adhkar_library`, which adds both lists.
  - With `apply` ticked, it also approves the pending entries that came from them.
  - Entries an admin rejected or added are never changed.
  - Idempotent.
  - Idempotent.
  - Returns `{created, existing, missing}`.
- `POST admin/adhkar/<id>/test`: sends that approved entry to the admin's own devices (once per 30 s).
- `GET admin/adhkar/stats`: last 7 days.
  - Notices and accounts reached, and counts by `push_status`.
  - Most-sent entries.
  - The latest 30 failed deliveries (role, status, error, attempts).
  - Library counts.
- Every create, edit, review and enable is written to the audit log (`adhkar.*`).

**Sending** (`adhkar_reminders` step of the hourly job `run_scheduled`, minute 23):
- Who: active accounts with an active push device and adhkar on.
- Time: each account's own time zone. DST-safe: a skipped hour runs at the transition, and a repeated hour cannot
  send twice.
- Morning, evening and sleep: once a day from entries of that time, caught up for 3 hours after the chosen hour.
- Periodic: every N hours inside the window, from the general categories plus Quranic/prophetic duas when those are on.
- Never in quiet hours. At most one adhkar notice per account per run.
- Each slot (`morning:<date>`, `p:<date>:<HH>`) is used once per account, enforced by a unique row.
- Rotation: the entry this account has gone longest without, so no repeats until the eligible set is exhausted.
- With no approved entries for a slot, nothing is sent.
- Notice kind `adhkar_<category>`: the title is «الحلقة | …»; the body is the text (shortened at a word) plus the
  source.
  - Tapping opens `#/n/<id>`, which opens the entry.
  - Excluded from the learning inbox and its unread count.

## Teacher assignment and reassignment (owner report, 14 Nov 2026)

**Rule:** a student has at most one active teacher.
- Enforced by the PostgreSQL partial unique index `one_active_teacher_per_student` (`student` where `active`).
- Every path goes through `apps/accounts/reassign.assign_teacher`: the student record, the bulk action,
  «اختر معلمك», and accepting a teacher's invitation.

**What `assign_teacher` does, in one transaction:**
1. Validates the student (active) and the teacher (active, approved).
2. Locks the student row, so concurrent changes run one after the other and the last one wins.
3. Ends the current assignment: `active=false`, `ended_at`, `ended_by`, `end_reason="reassigned"`. The row is kept as
   history.
4. Creates the new active assignment and writes the audit event `admin.teacher_reassigned` (or
   `admin.teacher_assigned`).
5. Creates the notifications in the same transaction (the outbox; push goes out after commit, retried hourly):

| Recipient | Kind | Title | Body |
| --- | --- | --- | --- |
| Student | `teacher_assigned` | «تم تغيير معلمك في حلقة» («تم تعيين…» if it is the first teacher) | «تم تعيين الأستاذ/الأستاذة … معلمًا/معلمةً لك. يمكنك الآن متابعة الحفظ والمراجعة معه/معها.» |
| New teacher | `student_assigned` | «طالب جديد في حلقتك» | «تم تعيين الطالب/الطالبة … ضمن طلابك.» |
| Previous teacher | `student_moved` | «تحديث قائمة الطلاب» | «تم نقل الطالب/الطالبة … إلى معلم آخر.» |

- Teacher titles follow the teacher's gender: الأستاذ or الأستاذة. With no gender set, the name is shown with no
  title. «الأستاذ» is never used in these notices.
- Assigning the teacher the student already has changes nothing and notifies no one.
- These three kinds carry the wording above on the phone (push), not the generic text.
- Tasks, recordings, evaluations, attendance and memorization progress are never changed or deleted.
- The previous teacher keeps the tasks they wrote, but no longer sees the student, the student's recordings, or new
  submissions. New recordings notify the current teacher.

**API**
- `POST admin/teacher-assignments {teacher, student}` (`teachers.assign`).
  - 201 with `{id, teacher, student, active, created_at, teacher_name, previous: {id, teacher} | null}`.
  - 200 when that teacher was already assigned.
  - 400 for an invalid or unapproved teacher, or an account that is not a student. 409 for a suspended student.
- Bulk `assign_teacher`: a student who has another teacher is skipped unless `replace` is set.
- `GET me` → `teacher: {id, name, since} | null` for students. This is the authoritative current teacher, read on
  every app start; it is never derived from tasks.
- `GET notifications/unread` → `{unread, assignment_rev}`. `assignment_rev` changes whenever this account's
  teacher↔student links change.

**Keeping open screens current** (there is no WebSocket or SSE). The app reloads the account and the role's data
when `assignment_rev` changes. It checks:
- every 60 s on every screen;
- when the app returns to the foreground;
- immediately when a push arrives (the service worker posts `halqa:push` to open windows).

**Existing data:** migration `accounts.0017` finds students with more than one active teacher (created by the old
«ربط بمعلم»).
- It keeps the newest assignment active.
- It ends the others with `end_reason="repair_duplicate"`; nothing is deleted.
- Each repair is written to the audit log as `data.teacher_assignment_repaired`, with both teachers.

## Meeting links, «انضم إلى الجلسة» and 15-minute reminders (owner request, 14 Nov 2026)

**Meeting links** (`PUT teacher/occurrences/<id>/meeting {url}`)
- The server normalizes the link (`apps/scheduling/meeting.normalize`; the app mirrors it in `src/lib/meeting.ts`,
  applied when the field loses focus and on save):
  - spaces, invisible characters and wrapping quotes are removed;
  - a missing protocol gets `https://` (once), and `http://` becomes `https://`;
  - the host, path, meeting ID and query are kept;
  - any other scheme (`javascript:`, `data:`, `ftp:` …) is refused.
- It then checks the link (`provider_for`): Google Meet, Zoom, Microsoft Teams or Jitsi only, no host or sign-in
  links, no `user:password@`, standard port.
- The normalized link is stored in `SessionOccurrence.meeting_url`.
- Example: `meet.google.com/mes-bjhv-zzf` is stored as `https://meet.google.com/mes-bjhv-zzf`.

**Joining**
- Student: `POST bookings/<id>/join` returns `{url, provider, provider_label}`.
  - Only the booked student, only inside the join window (`AppSettings.join_minutes` before the start, until the end).
  - Everyone else gets 404.
  - Booking lists carry `has_meeting_link`, `can_join` and `meeting_provider` (the platform's name), never the URL.
- Teacher: their own session's `meeting_url` (`teacher/occurrences`).
- App: one «انضم إلى الجلسة» button (`src/components/JoinButton.tsx`).
  - Student: home card, upcoming list, session details, the join screen, and the reminder's destination.
  - Teacher: «جلسات اليوم», «المواعيد» sessions.
  - It opens the link in a new browsing context. On Android the Meet, Zoom or Teams app takes it when installed.
  - It is disabled, with the reason, when there is no link or the window is not open.

**15-minute reminder** (`apps/scheduling/reminders.py`)
- Kind `session_soon`, title «الحلقة | تذكير بالجلسة», body «حلقتك هتبدأ بعد 15 دقيقة. استعد للانضمام إلى الجلسة.».
- Sent to every student with a confirmed booking and to the teacher, in-app plus Web Push, through the outbox:
  - push after commit;
  - `push_status`, `push_attempts` and `push_error` recorded;
  - hourly retry of temporary failures.
- `push_status="sent"` means the push service accepted it, not that the phone displayed it; the device receipt is
  separate.
- Tapping it opens the student's session (`live`) or the teacher's «المواعيد».
- **Due:** sessions that are SCHEDULED, have a confirmed booking, and start within 15 minutes (plus 45 s), not yet
  started.
  - The dedupe key includes the start time, so one reminder per person, session and time.
  - A moved session is reminded for its new time only; cancelled or completed sessions never are.
  - Booked or created less than 15 minutes ahead: reminded at once («بعد N دقائق»).
- Times are UTC instants, so Cairo DST changes (and each person's own zone) do not move the reminder.
- **Who triggers it:** a Google Cloud Tasks one-shot task at T−15 per session and start time (`alarm.py`), created
  when a session is created or moved or a booking is confirmed. It calls `POST internal/session-reminders` with the
  `X-Halqa-Task` secret (404 without it).
- **Safety nets:**
  - the unread-count poll (at most one check a minute across all open apps);
  - the hourly job, which also re-arms alarms for booked sessions in the next 2 hours.
- `GET /api/ready` reports `features.session_reminders`:
  - `alarm`: configured (`deploy/gcp-reminders.sh`);
  - `fallback`: app poll and hourly job only.
- Reschedule and cancellation notices to both sides are unchanged (`booking_rescheduled`, `booking_cancelled`,
  `session_cancelled*`).

**Teacher titles:** «الأستاذ» for men, «الأستاذة» for women, everywhere (`display.py`, `names.ts`). An old typed
«الشيخ» is removed before the title is added.
