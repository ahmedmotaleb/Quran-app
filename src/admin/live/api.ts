/** Admin portal API (live mode). Every call is admin-only on the server; nothing here is trusted client-side. */
import { api, apiDownload, type Page } from '@/api/client';

export type Role = 'student' | 'teacher' | 'parent';
export type AccountStatus = 'pending' | 'active' | 'suspended' | 'archived';
export interface Person {
  id: number; email: string; full_name: string; role: Role; status: AccountStatus; timezone: string; phone: string; phone_verified?: boolean;
  level: string; approved: boolean | null; has_password: boolean; date_joined: string; last_login: string | null;
  status_reason: string; status_changed_at: string | null;
  setup_email_status: '' | 'sent' | 'failed'; setup_email_last_at: string | null; setup_email_count: number;
  teachers: { id: number; name: string; assignment_id: number }[];
  guardians: { id: number; name: string; status: string; link_id: number }[];
  children: { id: number; name: string; status: string; link_id: number }[];
}
export interface SetupLink { setup_email_sent: boolean; setup_link: string | null; sent_to?: string }
export type Counts = Record<AccountStatus | 'all', number> & { unapproved?: number; unlinked?: number };

type P = Record<string, string | number | undefined>;
const qs = (p: P) =>
  Object.entries(p).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

export const listPeople = (p: { role: Role; q?: string; status?: string; page?: number; page_size?: number; unlinked?: string; sort?: string } & P) =>
  api<Page<Person>>('GET', `admin/users?${qs(p)}`);
export const peopleCounts = (role: Role) => api<Counts>('GET', `admin/users/counts?role=${role}`);
export const getPerson = (id: number) => api<Person>('GET', `admin/users/${id}`);
export const updatePerson = (id: number, patch: Partial<Pick<Person, 'full_name' | 'phone' | 'timezone'>>) => api<Person>('PATCH', `admin/users/${id}`, patch);
export const setPersonStatus = (id: number, status: AccountStatus, reason = '') => api<Person>('POST', `admin/users/${id}/status`, { status, reason });
export const createPerson = (full_name: string, email: string, role: 'student' | 'parent') =>
  api<Person & SetupLink>('POST', 'admin/users', { full_name, email, role });
/** Emails a fresh setup link. `share` (owner only, and only when the email fails): also return the link to copy. */
export const newSetupLink = (id: number, share = false) => api<SetupLink>('POST', `admin/users/${id}/setup-link`, share ? { share: true } : {});
/** «إنشاء الحساب وإرسال رابط الإعداد»: the teacher account exists at once (unapproved); the setup email goes directly. */
/** A task for a student by an academic admin (assignments.manage); `teacher`: one of the student's linked teachers. */
export const adminCreateTask = (b: { student: number; teacher?: number; kind: string; title: string; surah: number; ayah_from: number; ayah_to: number;
  instructions: string; due_at: string; requires_recording: boolean }) => api<{ id: number; title: string; teacher_name: string }>('POST', 'admin/assignments', b);
export const createTeacher = (full_name: string, email: string) => api<Person & SetupLink>('POST', 'admin/teachers', { full_name, email });
export const setTeacherApproval = (id: number, approved: boolean, reason = '') => api<Person>('POST', `admin/teachers/${id}/approval`, { approved, reason });
export const assignTeacher = (teacher: number, student: number) => api<{ id: number }>('POST', 'admin/teacher-assignments', { teacher, student });
export const endAssignment = (id: number) => api<null>('POST', `admin/teacher-assignments/${id}/end`);
export const linkGuardian = (guardian: number, student: number) => api<{ id: number }>('POST', 'admin/guardian-links', { guardian, student });
export const revokeGuardian = (id: number, reason: string) => api<null>('POST', `admin/guardian-links/${id}/revoke`, { reason });
export interface Invitation {
  id: number; purpose: 'teacher_account' | 'guardian_link' | 'student_teacher'; purpose_label: string; email: string;
  status: 'pending' | 'failed' | 'expired' | 'accepted' | 'revoked'; email_status: '' | 'sent' | 'failed'; send_count: number;
  last_sent_at: string | null; expires_at: string; created_at: string; created_by: string | null;
}
type InviteSent = Invitation & { email_sent: boolean; link?: string };
/** The server emails the invitation; `share` also returns the link once, to send over WhatsApp. */
export const inviteTeacher = (email: string, share = false) =>
  api<InviteSent>('POST', 'invitations', { purpose: 'teacher_account', email, days: 7, share_link: share });
export const listInvitations = (purpose?: string) => api<{ results: Invitation[] }>('GET', `invitations?open=1${purpose ? `&purpose=${purpose}` : ''}`);
export const resendInvitation = (id: number, share = false) => api<InviteSent>('POST', `invitations/${id}/resend`, { share_link: share });
export const revokeInvitation = (id: number) => api<Invitation>('POST', `invitations/${id}/revoke`);

/* ---- Circles, sessions, bookings (prompt 06) ---- */
export type CircleState = 'draft' | 'published' | 'off';
export interface Circle {
  id: number; name: string; teacher: { id: number; name: string }; level: string; capacity: number; schedule_note: string; state: CircleState;
  upcoming_sessions: number; upcoming_booked_seats: number; updated_at: string; members?: number;
}
export interface CircleMember { id: number; student: { id: number; name: string }; active: boolean; joined_at: string; ended_at: string | null; end_reason: string }
export interface SessionRow { id: number; starts_at: string; ends_at: string; status: 'scheduled' | 'cancelled' | 'completed'; capacity: number; booked: number }
export interface PlanItem { starts_at: string; ends_at: string; ok: boolean; problem: string }
export interface Booking {
  id: number; status: 'confirmed' | 'cancelled'; attendance: string; starts_at: string; ends_at: string; kind: 'individual' | 'group';
  circle: string | null; session_status: string; teacher: { id: number; name: string }; student: { id: number; name: string };
  cancel_reason: string; cancelled_at: string | null; cancelled_by: string | null;
}
export const listCircles = (p: P) => api<Page<Circle>>('GET', `admin/circles?${qs(p)}`);
export const getCircle = (id: number) => api<Circle & { sessions: SessionRow[] }>('GET', `admin/circles/${id}`);
export const createCircle = (d: { name: string; teacher: number; capacity: number; level: string; schedule_note: string }) => api<Circle>('POST', 'admin/circles', d);
export const updateCircle = (id: number, d: Partial<{ name: string; capacity: number; level: string; schedule_note: string }>) => api<Circle>('PATCH', `admin/circles/${id}`, d);
export const circleMembers = (id: number) => api<{ capacity: number; active: number; results: CircleMember[] }>('GET', `admin/circles/${id}/members`);
export const addCircleMember = (id: number, student: number) => api<CircleMember & { booked: number; full: number; conflict: number }>('POST', `admin/circles/${id}/members`, { student });
export const endCircleMember = (id: number, reason: string) => api<{ bookings_cancelled: number }>('POST', `admin/circle-members/${id}/end`, { reason });
export const setCircleState = (id: number, state: CircleState, reason = '') => api<Circle>('POST', `admin/circles/${id}/state`, { state, reason });
export const scheduleCircle = (id: number, d: { weekday: number; time: string; minutes: number; weeks: number; start?: string; timezone: string; dry_run: boolean }) =>
  api<{ dry_run: boolean; created: number; replaced_open_slots: number; timezone: string; plan: PlanItem[]; members_booked?: number }>('POST', `admin/circles/${id}/sessions`, d);
export const cancelSession = (id: number, reason: string) => api<{ bookings_cancelled: number }>('POST', `admin/sessions/${id}/cancel`, { reason });
export const listBookings = (p: P) => api<Page<Booking>>('GET', `admin/bookings?${qs(p)}`);
export const cancelBooking = (id: number, reason: string) => api<Booking>('POST', `admin/bookings/${id}/cancel`, { reason });

/* ---- Courses, lessons, enrollments, quizzes (prompt 07) ---- */
export type PubState = 'draft' | 'pending' | 'published' | 'archived';
export interface Course {
  id: number; title: string; description: string; topic: string; level: string; teacher: { id: number; name: string }; state: PubState;
  restricted: boolean; lessons: number; published_lessons: number; enrolled: number; updated_at: string;
}
export interface Lesson { id: number; course: number; order: number; title: string; kind: 'text' | 'video' | 'audio' | 'pdf'; body: string; external_url: string; duration_minutes: number | null; state: PubState; has_file: boolean }
export interface Enrollment { id: number; student: { id: number; name: string; email: string }; status: 'active' | 'completed' | 'withdrawn'; starts_on: string | null; ends_on: string | null }
export type TestState = 'draft' | 'pending' | 'published' | 'closed';
export interface Quiz {
  id: number; title: string; course: { id: number; title: string } | null; topic: string; level: string; state: TestState; duration_minutes: number | null;
  max_attempts: number; opens_at: string | null; closes_at: string | null; release_results: boolean; questions: number; attempts: number;
}
export type QKind = 'mcq' | 'true_false' | 'short' | 'recitation';
export interface Question { id: number; order: number; version: number; kind: QKind; prompt: string; options: string[] | { surah?: number; ayah_from?: number; ayah_to?: number }; answer_key: unknown; points: number; used: number | null }

export type Drafts = { lessons: number; tests: number; lessons_by_teachers: number; tests_by_teachers: number };
export const contentDrafts = () => api<Drafts>('GET', 'admin/content/drafts');
export const listCourses = (p: P) => api<Page<Course>>('GET', `admin/courses?${qs(p)}`);
export const getCourse = (id: number) => api<Course & { lesson_list: Lesson[] }>('GET', `admin/courses/${id}`);
export const saveCourse = (id: number | null, d: Partial<{ title: string; description: string; topic: string; level: string; teacher: number; restricted: boolean }>) =>
  id ? api<Course>('PATCH', `admin/courses/${id}`, d) : api<Course>('POST', 'admin/courses', d);
export const setCourseState = (id: number, state: PubState, reason = '') => api<Course>('POST', `admin/courses/${id}/state`, { state, reason });
export const saveLesson = (courseId: number, id: number | null, d: Partial<{ title: string; kind: string; body: string; external_url: string; duration_minutes: number | null; media: string }>) =>
  id ? api<Lesson>('PATCH', `admin/lessons/${id}`, d) : api<Lesson>('POST', `admin/courses/${courseId}/lessons`, d);
export const setLessonState = (id: number, state: PubState) => api<Lesson>('POST', `admin/lessons/${id}/state`, { state });
export const listEnrollments = (courseId: number, page = 1) => api<Page<Enrollment>>('GET', `admin/courses/${courseId}/enrollments?page=${page}&page_size=100`);
export const enroll = (courseId: number, student: number) => api<Enrollment>('POST', `admin/courses/${courseId}/enrollments`, { student });
export const endEnrollment = (id: number, status: 'withdrawn' | 'completed', reason = '') => api<Enrollment>('POST', `admin/enrollments/${id}/end`, { status, reason });
export const listQuizzes = (p: P) => api<Page<Quiz>>('GET', `admin/tests?${qs(p)}`);
export const getQuiz = (id: number) => api<Quiz & { question_list: Question[] }>('GET', `admin/tests/${id}`);
export const saveQuiz = (id: number | null, d: Partial<{ title: string; course: number | null; topic: string; level: string; duration_minutes: number | null; max_attempts: number }>) =>
  id ? api<Quiz>('PATCH', `admin/tests/${id}`, d) : api<Quiz>('POST', 'admin/tests', d);
export const setQuizState = (id: number, state: TestState) => api<Quiz>('POST', `admin/tests/${id}/state`, { state });
export const saveQuestion = (testId: number, id: number | null, d: Partial<Omit<Question, 'id' | 'version' | 'used'>>) =>
  id ? api<Question>('PATCH', `admin/questions/${id}`, d) : api<Question>('POST', `admin/tests/${testId}/questions`, d);
export const removeQuestion = (id: number) => api<null>('DELETE', `admin/questions/${id}`);

/* ---- Settings and audit (prompt 08) ---- */
export interface Settings {
  org_name: string; support_email: string; support_whatsapp: string; show_support_button: boolean; default_timezone: string;
  cancel_hours: number; excuse_deadline_minutes: number; join_minutes: number; individual_minutes: number; group_minutes: number; booking_horizon_days: number;
  booking_lead_minutes: number; open_signup: boolean; session_reminders: boolean; parent_weekly_report: boolean;
  max_recording_seconds: number; max_upload_mb: number; review_intervals: number[]; updated_at: string; sensitive: string[];
  waitlist_offer_hours: number; makeup_enabled: boolean; makeup_expiry_days: number; makeup_granters: 'teachers_admins' | 'admins';
  parent_report_weekday: number; parent_report_hour: number; parent_report_email: boolean;
}
export interface AuditRow { id: number; at: string; action: string; actor: string | null; target: string; data: Record<string, unknown> }
export const getSettings = () => api<Settings>('GET', 'admin/settings');
export const saveSettings = (d: Partial<Settings> & { current_password?: string }) => api<Settings>('PATCH', 'admin/settings', d);
export const listAudit = (p: { action?: string; page?: number }) => api<Page<AuditRow>>('GET', `admin/audit?${qs(p)}`);

/* ---- Bulk actions (select-all + bulk toolbar) ---- */
export type BulkResource = 'users' | 'circles' | 'bookings' | 'sessions' | 'courses' | 'lessons' | 'enrollments' | 'tests' | 'questions';
export interface BulkBody { action: string; ids?: number[]; filter?: Record<string, string>; expected?: number; exclude_ids?: number[]; reason?: string; confirm?: string; params?: Record<string, unknown>; otp?: string }
export interface BulkItem { id: number; label: string; outcome: 'skipped' | 'failed'; code: string; message: string }
export interface BulkResult { requested: number; success: number; skipped: number; failed: number; results: BulkItem[]; errors: BulkItem[] }
export interface TrustedDevice { id: number; label: string; created_at: string; expires_at: string; last_used_at: string | null; current: boolean }
export const listTrustedDevices = () => api<{ results: TrustedDevice[]; days: number }>('GET', 'admin/trusted-devices');
export const revokeTrustedDevice = (id: number) => api<{ removed: number }>('POST', `admin/trusted-devices/${id}/revoke`);
export const revokeAllTrustedDevices = () => api<{ removed: number }>('DELETE', 'admin/trusted-devices');
export interface PromoteResult { approved: boolean; emailed: boolean; assignments_ended: number; bookings_cancelled: number; memberships_ended: number;
  guardian_links_revoked: number; enrollments_withdrawn: number; person: Person }
/** Student → Teacher (same account). Reason and the typed word «ترقية» are checked again by the server. */
export const promoteTeacher = (id: number, reason: string, approve: boolean) =>
  api<PromoteResult>('POST', `admin/users/${id}/promote-teacher`, { reason, approve, confirm: 'ترقية' });
/** Attendance and the absence rule for one student (unexcused absences derived on the server). */
export interface Discipline {
  total_sessions: number; present: number; late: number; excused: number; approved_excuses: number; pending_excuses: number;
  rejected_excuses: number; unexcused_absences: number; limit: number; suspends_at: number; suspended: boolean; status_reason: string;
  absences: { booking: number; starts_at: string; teacher: string; attendance: string; counts: boolean; excuse: string | null; makeup?: string | null }[];
  excuses: import('@/api/endpoints').ApiExcuseRow[];
}
/** «منح جلسة تعويضية» for an approved excuse (excuses.review). */
export const grantMakeup = (bookingId: number) => api<{ id: number; status: string; expires_at: string }>('POST', `admin/bookings/${bookingId}/makeup`);
export const discipline = (id: number) => api<Discipline>('GET', `admin/users/${id}/discipline`);
export const excuseOverride = (bookingId: number, reason: string) => api<unknown>('POST', `admin/bookings/${bookingId}/excuse-override`, { reason });
export const adminExcuses = (status = 'pending') => api<{ results: import('@/api/endpoints').ApiExcuseRow[] }>('GET', `admin/excuses?status=${status}`);
export const bulkAction = (resource: string, body: BulkBody) => api<BulkResult>('POST', `admin/${resource}/bulk-action`, body);
export const exportCsv = (resource: string, body: Omit<BulkBody, 'action'> & { sort?: string }) => apiDownload(`admin/${resource}/export`, body);
export interface SavedView { id: number; section: string; name: string; query: string }
export const savedViews = (section: string) => api<SavedView[]>('GET', `admin/saved-views?section=${encodeURIComponent(section)}`);
export const saveView = (section: string, name: string, query: string) => api<SavedView>('POST', 'admin/saved-views', { section, name, query });
export const deleteView = (id: number) => api<null>('DELETE', `admin/saved-views/${id}`);

/* ---------------- admins & permissions (owner request, 23 October 2026) ---------------- */
export interface AdminRow {
  id: number; full_name: string; email: string; phone: string; status: AccountStatus; mfa_enabled: boolean; last_login: string | null;
  level: 'owner' | 'admin' | ''; preset: string; preset_label: string; permissions: string[]; is_self: boolean;
}
export interface AdminInvite extends Omit<Invitation, 'purpose'> { purpose: 'admin_account'; level: string; preset: string }
export interface AdminsPage {
  results: AdminRow[]; invitations: AdminInvite[];
  permissions: Record<string, string>; presets: Record<string, string[]>; preset_labels: Record<string, string>;
}
export interface AdminAccess { level: 'owner' | 'admin'; preset: string; permissions: string[] }
export const listAdmins = () => api<AdminsPage>('GET', 'admin/admins');
export const inviteAdmin = (d: AdminAccess & { full_name: string; email: string; otp: string }) =>
  api<{ id: number; email_sent: boolean; expires_at: string }>('POST', 'admin/admins', d);
export const updateAdmin = (id: number, d: AdminAccess & { otp: string }) => api<AdminRow>('PATCH', `admin/admins/${id}`, d);
export const setAdminStatus = (id: number, status: 'active' | 'suspended', reason: string, otp: string) =>
  api<AdminRow>('POST', `admin/admins/${id}/status`, { status, reason, otp });

/* ---------------- Reports (PROMPT 46): numbers aggregated on the server ---------------- */
export type Ratio = { value: number | null; num: number; den: number };
export type KpiFilter = { from?: string; to?: string; teacher?: number | ''; circle?: number | '' };
export type KpiRange = { from: string; to: string; timezone: string; teacher: number | null; circle: number | null };
export type Kpis = {
  active_students: number; active_teachers: number; new_registrations: number; suspended_by_absence: number;
  attendance: { present: number; late: number; absent: number; excused: number; unmarked: number; attendance_rate: Ratio; unexcused_absence_rate: Ratio };
  booking_fill_rate: Ratio; circle_capacity_utilization: Ratio; assignment_completion: Ratio & { submitted_waiting: number };
  review_turnaround_hours: { median: number | null; reviews: number }; pending_teacher_approvals: number; pending_excuses: number;
  recording_review_backlog: { count: number; oldest_hours: number | null };
};
export type Workload = {
  teacher: { id: number; name: string; approved: boolean }; active_students: number; circle_students: number; upcoming_sessions: number;
  available_slots: number; utilization: Ratio; awaiting_review: number; overdue_feedback: number; pending_excuses: number;
  unresolved_mistakes: number; attendance_rate: Ratio; no_show_rate: Ratio;
};
const kq = (f: KpiFilter) => qs({ from: f.from, to: f.to, teacher: f.teacher || undefined, circle: f.circle || undefined });
export const getKpis = (f: KpiFilter) => api<{ range: KpiRange; kpis: Kpis; definitions: Record<string, string>; not_filtered: Record<string, string[]> }>('GET', `admin/kpis?${kq(f)}`);
export const getWorkload = (f: KpiFilter) => api<{ range: KpiRange; results: Workload[]; definitions: Record<string, string> }>('GET', `admin/teacher-workload?${kq(f)}`);
export const exportWorkload = (f: KpiFilter) => apiDownload('admin/teacher-workload/export', f);
