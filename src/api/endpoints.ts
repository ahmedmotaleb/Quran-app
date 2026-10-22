/** Typed API calls and adapters from server records to the screens' data shapes. */
import type { Feedback, Session, Student, Task, TaskStatus, Teacher } from '@/data/types';
import { fmtRelative } from '@/lib/time';
import { baseType, fileNameFor } from '@/services/media';
import { api, newIdempotencyKey, type Page } from './client';

export type ApiRole = 'student' | 'teacher' | 'parent' | 'admin';
export interface Me {
  id: number; email: string; full_name: string; role: ApiRole; status: string; timezone: string; phone: string;
  mfa_enabled: boolean; mfa_required?: boolean; level: string; daily_goal: string;
}
export interface LoginResult { user: Me; token?: string }

export interface ApiAssignment {
  id: number; student: number; student_name: string; teacher: number; teacher_name: string; kind: 'hifz' | 'review' | 'tajweed';
  title: string; surah: number; ayah_from: number; ayah_to: number; instructions: string; due_at: string; requires_recording: boolean;
  status: 'not_started' | 'in_progress' | 'submitted' | 'accepted' | 'needs_repeat'; next_review_on: string | null; created_at: string;
}
export interface ApiTeacher {
  id: number; full_name: string; timezone: string; specialization: string; bio: string; audience: string; levels: string; tags: string[];
  offers_individual: boolean; offers_group: boolean;
}
export interface ApiSlot { id: number; teacher: number; teacher_name: string; kind: 'individual' | 'group'; starts_at: string; ends_at: string; capacity: number; seats_left: number }
export interface ApiBooking {
  id: number; occurrence: ApiSlot; student: number; student_name: string; status: 'confirmed' | 'cancelled'; assignment: number | null;
  note: string; attendance: string; cancelled_at: string | null; cancel_reason: string; created_at: string; can_join: boolean;
  has_meeting_link: boolean; excuse: ApiExcuse | null; excuse_deadline: string; can_excuse: boolean;
}
/** A student's excuse for a booking. `reason`/`teacher_response` are absent for parents (status only). */
export interface ApiExcuse {
  booking: number; status: 'pending' | 'approved' | 'rejected'; requested_at: string; reviewed_at: string | null; overridden: boolean;
  reason?: string; teacher_response?: string;
}
export interface ApiExcuseRow extends ApiExcuse {
  student: { id: number; name: string }; teacher: { id: number; name: string }; starts_at: string; kind: string; attendance: string;
  teacher_status: string; override_reason: string;
}

// ---- auth ----
export const login = (email: string, password: string) => api<LoginResult>('POST', 'auth/login', { email, password, client: 'web' });
export const register = (full_name: string, email: string, password: string, timezone: string) =>
  api<LoginResult>('POST', 'auth/register', { full_name, email, password, client: 'web', timezone });
export const logout = () => api<null>('POST', 'auth/logout');
// Admin portal (separate sign-in; the server rejects non-admin accounts).
export const adminLogin = (email: string, password: string, otp: string, trust_device = false) =>
  api<LoginResult>('POST', 'admin/auth/login', { email, password, otp, client: 'web', trust_device });
export const mfaSetup = () => api<{ secret: string; otpauth_uri: string }>('POST', 'admin/mfa/setup');
export const mfaConfirm = (otp: string) => api<{ mfa_enabled: boolean }>('POST', 'admin/mfa/confirm', { otp });
export const me = () => api<Me>('GET', 'me');
export const publicSettings = () => api<{ cancel_hours: number; open_signup: boolean; max_recording_seconds: number; join_minutes: number; org_name: string;
  ayah_audio: AyahAudioCfg | null; support_whatsapp: string; show_support_button: boolean }>('GET', 'settings/public');
export const updateMe = (patch: Partial<Pick<Me, 'full_name' | 'timezone' | 'phone'>>) => api<Me>('PATCH', 'me', patch);
export const saveOnboarding = (d: { level: string; daily_goal: string; preferred_days: string[]; preferred_period: string }) =>
  api<Me>('PUT', 'me/onboarding', d);
export const forgot = (email: string) => api<{ message: string }>('POST', 'auth/password/forgot', { email });

// ---- learning ----
export const assignments = () => api<Page<ApiAssignment>>('GET', 'assignments?page_size=100');
export const startAssignment = (id: number) => api<ApiAssignment>('POST', `assignments/${id}/start`);

// ---- booking ----
export const teachers = () => api<Page<ApiTeacher>>('GET', 'teachers?page_size=100');
export const slots = (teacherId: number) => api<ApiSlot[]>('GET', `teachers/${teacherId}/slots`);
export const bookings = () => api<Page<ApiBooking>>('GET', 'bookings?page_size=100');
export const book = (occurrence: number, key: string, assignment: number | null, note: string) =>
  api<ApiBooking>('POST', 'bookings', { occurrence, assignment, note }, { idempotencyKey: key });
/** Teacher (own session) or admin. Students cannot cancel: they send an excuse. */
export const cancelBooking = (id: number, reason = '') => api<ApiBooking>('POST', `bookings/${id}/cancel`, { reason });
export const requestExcuse = (id: number, reason: string) => api<ApiExcuse>('POST', `bookings/${id}/excuse`, { reason });
export const teacherExcuses = (status = 'pending') => api<{ results: ApiExcuseRow[] }>('GET', `teacher/excuses?status=${status}`);
export const reviewExcuse = (bookingId: number, approve: boolean, response: string) =>
  api<ApiExcuse>('POST', `teacher/bookings/${bookingId}/excuse/${approve ? 'approve' : 'reject'}`, { response });
export const reschedule = (id: number, occurrence: number, key: string) =>
  api<ApiBooking>('POST', `bookings/${id}/reschedule`, { occurrence }, { idempotencyKey: key });
export { newIdempotencyKey };

// ---- recordings, submissions, feedback ----
export interface SignedUrl { url: string; expires_at: string }
export interface ApiMedia extends SignedUrl { id: string; duration_seconds: number }
export interface ApiFeedback {
  id: number; teacher: number; teacher_name: string; created_at: string; score_hifz: number; score_tajweed: number; score_fluency: number;
  decision: 'accept' | 'repeat'; general: string; needs_review: string; next_step: string;
  notes: { at_seconds: number; text: string }[]; voice: SignedUrl | null; voice_seconds: number | null;
}
export interface ApiSubmission {
  id: number; assignment: number; assignment_title: string; kind: string; surah: number; ayah_from: number; ayah_to: number;
  student: number; student_name: string; attempt: number; duration_seconds: number; created_at: string;
  audio: SignedUrl | null; audio_deleted: boolean; feedback: ApiFeedback | null;
}
export interface ApiTeacherStudent { id: number; full_name: string; level: string; birth_year: number | null; guardian_linked: boolean }

/** Multipart body for a recording. The part keeps the type the recorder really produced (the server checks the bytes
 *  against it) and gets a matching file name. `FormData.append(name, blob, filename)` needs no File constructor, which
 *  older mobile browsers lack. A blob without a type is labelled with the recorder's reported type, never a guess. */
export function audioForm(blob: Blob, mime: string, seconds: number, stem: string): FormData {
  const type = baseType(blob.type || mime);
  const part = blob.type ? blob : new Blob([blob], { type });
  const f = new FormData();
  f.append('file', part, fileNameFor(type, stem));
  f.append('duration_seconds', String(Math.max(1, Math.round(seconds))));
  return f;
}
export function uploadRecitation(blob: Blob, seconds: number, opts: { mime?: string; uploadId?: string } = {}) {
  return api<ApiMedia>('POST', 'media/recitations', audioForm(blob, opts.mime ?? '', seconds, 'recitation'), { uploadId: opts.uploadId });
}
export function uploadVoiceNote(blob: Blob, seconds: number) {
  return api<ApiMedia>('POST', 'media/voice-feedback', audioForm(blob, '', seconds, 'voice-note'));
}
/** A lesson file (PDF or audio) for admins/teachers. Audio length is read in the browser when possible. */
export async function uploadLessonFile(file: File) {
  const f = new FormData();
  f.append('file', file);
  if (file.type.startsWith('audio/')) {
    const secs = await new Promise<number>((res) => {
      const a = new Audio(); const url = URL.createObjectURL(file);
      a.preload = 'metadata'; a.onloadedmetadata = () => { URL.revokeObjectURL(url); res(a.duration); };
      a.onerror = () => { URL.revokeObjectURL(url); res(NaN); }; a.src = url;
    });
    if (Number.isFinite(secs) && secs >= 1) f.append('duration_seconds', String(Math.round(secs)));
  }
  return api<ApiMedia & { content_type: string }>('POST', 'media/lesson-files', f);
}
export const LESSON_FILE_ACCEPT = 'application/pdf,audio/mpeg,audio/mp4,audio/x-m4a,audio/aac,audio/wav,audio/ogg,audio/webm';
export const submit = (assignment: number, media: string, key: string) =>
  api<ApiSubmission>('POST', `assignments/${assignment}/submissions`, { media }, { idempotencyKey: key });
export const submissions = (q = '') => api<Page<ApiSubmission>>('GET', `submissions?page_size=100${q}`);
export const giveFeedback = (id: number, body: {
  score_hifz: number; score_tajweed: number; score_fluency: number; decision: 'accept' | 'repeat';
  general: string; needs_review: string; next_step: string; notes: { at_seconds: number; text: string }[]; voice?: string | null;
}) => api<ApiSubmission>('POST', `submissions/${id}/feedback`, body);
export const teacherStudents = () => api<Page<ApiTeacherStudent>>('GET', 'teacher/students?page_size=100');
export interface ApiTeacherOcc {
  id: number; kind: 'individual' | 'group'; starts_at: string; ends_at: string; capacity: number; status: string;
  meeting_provider: string; meeting_url: string;
  bookings: { id: number; student: number; student_name: string; attendance: string; assignment_title: string; note: string; excuse: ApiExcuse | null }[];
}
export const teacherOccurrences = (days = 8) => api<ApiTeacherOcc[]>('GET', `teacher/occurrences?days=${days}`);
export const openSlot = (starts_at: string, minutes = 45) => api<ApiTeacherOcc>('POST', 'teacher/occurrences', { starts_at, minutes });
export const closeSlot = (id: number) => api<null>('POST', `teacher/occurrences/${id}/close`);
/** The teacher's participant link for their own session ("" clears it). */
export const setMeetingLink = (id: number, url: string) => api<ApiTeacherOcc>('PUT', `teacher/occurrences/${id}/meeting`, { url });
/** The booked student's link, only while the join window is open. */
export const joinBooking = (id: number) => api<{ url: string; provider: string; provider_label: string }>('POST', `bookings/${id}/join`);
export const markAttendance = (booking: number, attendance: string) => api<ApiBooking>('POST', `bookings/${booking}/attendance`, { attendance });
// ---- lessons & quizzes ----
export interface ApiLesson {
  id: number; title: string; kind: 'text' | 'video' | 'audio' | 'pdf'; course: number; course_title: string; topic: string; topic_label: string;
  level: string; duration_minutes: number | null; order: number; completed: boolean;
  body?: string; external_url?: string; media?: SignedUrl | null; next?: { id: number; title: string } | null;
}
export interface ApiAttemptSummary { id: number; number: number; status: 'in_progress' | 'submitted' | 'graded'; deadline_at: string | null; objective_score: number | null; objective_max: number | null; score: number | null; max: number }
export interface ApiQuestion { id: number; kind: 'mcq' | 'true_false' | 'short' | 'recitation'; prompt: string; options: string[]; points: number }
export interface ApiTest {
  id: number; title: string; topic: string; level: string; duration_minutes: number | null; max_attempts: number; question_count: number;
  has_recitation: boolean; attempts: ApiAttemptSummary[]; questions?: ApiQuestion[];
}
export interface ApiResult extends ApiAttemptSummary {
  test_title: string; answers: { answer: number; question: number; kind: ApiQuestion['kind']; prompt: string; options: string[]; points: number;
    response: unknown; is_correct: boolean | null; points_awarded: number | null; grade_reason: string; correct: unknown; recording: SignedUrl | null }[];
}
export interface ApiGradingItem {
  answer: number; attempt: number; test_title: string; student: number; student_name: string; kind: string; prompt: string; points: number;
  response: unknown; submitted_at: string; recording: SignedUrl | null; duration_seconds: number | null;
}
export const lessons = () => api<ApiLesson[]>('GET', 'lessons');
export const lesson = (id: number) => api<ApiLesson>('GET', `lessons/${id}`);
export const completeLesson = (id: number) => api<{ id: number; completed: boolean }>('POST', `lessons/${id}/complete`);
export const tests = () => api<ApiTest[]>('GET', 'tests');
export const testDetail = (id: number) => api<ApiTest>('GET', `tests/${id}`);
export const startAttempt = (testId: number) => api<ApiAttemptSummary>('POST', `tests/${testId}/attempts`);
export const submitAttempt = (id: number, answers: { question: number; response?: unknown; recording?: string }[]) =>
  api<ApiResult>('POST', `attempts/${id}/submit`, { answers });
export const attempt = (id: number) => api<ApiResult>('GET', `attempts/${id}`);
export const gradingQueue = () => api<ApiGradingItem[]>('GET', 'teacher/grading');
export const gradeAnswer = (id: number, points: number, reason: string) => api<{ attempt_status: string }>('POST', `answers/${id}/grade`, { points, reason });
export const parentChildren = () => api<Page<Me>>('GET', 'parent/children?page_size=50');
export const createAssignment = (b: {
  student: number; kind: string; title: string; surah: number; ayah_from: number; ayah_to: number; instructions: string; due_at: string; requires_recording: boolean;
}) => api<ApiAssignment>('POST', 'assignments', b);

// ---- adapters ----
const STATUS: Record<ApiAssignment['status'], TaskStatus> = {
  not_started: 'not_started', in_progress: 'in_progress', submitted: 'submitted', accepted: 'reviewed', needs_repeat: 'needs_repeat',
};

export function toTask(a: ApiAssignment, tz: string): Task {
  return {
    id: String(a.id), type: a.kind, title: a.title, s: a.surah, from: a.ayah_from, to: a.ayah_to,
    due: fmtRelative(a.due_at, tz), dueAt: a.due_at, status: STATUS[a.status], instr: a.instructions || 'لا توجد توجيهات إضافية.',
    today: fmtRelative(a.due_at, tz).startsWith('اليوم'), teacherName: a.teacher_name, sid: String(a.student),
  };
}

export function toTeacher(t: ApiTeacher): Teacher {
  const types = [t.offers_individual && 'فردية', t.offers_group && 'جماعية'].filter(Boolean) as string[];
  return {
    id: String(t.id), name: t.full_name, ini: t.full_name.replace(/^(الشيخ|الأستاذة?|د\.)\s+/, '').trim().charAt(0) || '؟',
    spec: t.specialization || '—', tags: t.tags ?? [], types: types.length ? types : ['فردية'], levels: t.levels || '—',
    aud: t.audience || '—', bio: t.bio || '',
  };
}

export function toSession(b: ApiBooking): Session {
  const o = b.occurrence;
  const minutes = Math.round((new Date(o.ends_at).getTime() - new Date(o.starts_at).getTime()) / 60000);
  const past = new Date(o.ends_at).getTime() < Date.now();
  return {
    id: String(b.id), t: String(o.teacher), teacherName: o.teacher_name, h: 0, type: o.kind === 'group' ? 'جماعية' : 'فردية', dur: minutes,
    status: b.status === 'cancelled' ? 'cancelled' : past ? 'completed' : 'confirmed',
    task: b.assignment ? String(b.assignment) : null, note: b.note, startsAt: o.starts_at, endsAt: o.ends_at, canJoin: b.can_join, hasLink: b.has_meeting_link, attendance: b.attendance,
    excuse: b.excuse, canExcuse: b.can_excuse, excuseDeadline: b.excuse_deadline,
  };
}

export function toFeedback(f: ApiFeedback, dur: number, tz: string): Feedback {
  return {
    teacher: String(f.teacher), date: fmtRelative(f.created_at, tz), dur,
    scores: { hifz: f.score_hifz, tajweed: f.score_tajweed, fluency: f.score_fluency },
    decision: f.decision === 'accept' ? 'approve' : 'redo',
    notes: f.notes.map((n) => ({ t: n.at_seconds, text: n.text })),
    voice: f.voice ? Math.round(f.voice_seconds ?? 0) || null : null, voiceUrl: f.voice?.url ?? null,
    general: f.general || '—', needs: f.needs_review || 'لا يوجد', next: f.next_step || (f.decision === 'accept' ? 'انتقل إلى النطاق التالي في خطتك.' : 'أعد تسجيل المواضع المحددة وأرسلها للمعلم.'),
  };
}

export function toStudent(u: ApiTeacherStudent): Student {
  const age = u.birth_year ? new Date().getFullYear() - u.birth_year : 0;
  return { id: String(u.id), name: u.full_name, ini: u.full_name.trim().charAt(0) || '؟', age, level: u.level || '—', plan: '—', att: '—', guardian: u.guardian_linked };
}

/* ---- Progress (one server calculation for every role; pack prompt 11) ---- */
export interface ApiProgress {
  student: { id: number; name: string; timezone: string }; range: { from: string; to: string };
  memorization: { assigned_ayahs: number; accepted_ayahs: number; pct: number | null };
  review: { due_today: number; overdue: number; completed: number };
  scores: { points: { date: string; hifz: number; tajweed: number; fluency: number; decision: 'accept' | 'repeat'; assignment: string }[];
    avg: { hifz: number | null; tajweed: number | null; fluency: number | null }; needs_repeat: number };
  latest_feedback: null | { date: string; teacher: string; assignment: string; decision: 'accept' | 'repeat'; general: string; next_step: string; needs_review: string; scores: { hifz: number; tajweed: number; fluency: number } };
  attendance: { present: number; late: number; absent: number; excused: number; unmarked: number; sessions: number; rate: number | null };
  practice: { submissions: number; minutes: number; reviewed: number };
  learning: { lessons_completed: number; quiz_attempts: number; quiz_avg_pct: number | null };
  assignments: { open: number; overdue: number; awaiting_review: number; accepted_in_range: number };
  streak_days: number; rules: Record<'memorization' | 'review' | 'attendance' | 'streak', string>;
}
const rangeQs = (from?: string, to?: string) => [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&');
export const myProgress = (from?: string, to?: string) => api<ApiProgress>('GET', `progress/me?${rangeQs(from, to)}`);
export const studentProgress = (id: number, from?: string, to?: string) => api<ApiProgress>('GET', `teacher/students/${id}/progress?${rangeQs(from, to)}`);
export const childProgress = (id: number, from?: string, to?: string) => api<ApiProgress>('GET', `parent/children/${id}/progress?${rangeQs(from, to)}`);

/* ---- ayah audio (licensed source: Quran Foundation / Quran.com) ---- */
export interface AyahAudioCfg { provider?: 'qf' | 'template'; url: string; name: string; default?: number; reciters?: { id: number; name: string }[] }
export const surahAudio = (n: number, reciter?: number | null) =>
  api<{ surah: number; reciter_id: number; requested?: number; reciter: string; source: string; ayahs: Record<string, string> }>('GET', `quran/audio/${n}${reciter ? `?reciter=${reciter}` : ''}`);
