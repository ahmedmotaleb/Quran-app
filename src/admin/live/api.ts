/** Admin portal API (live mode). Every call is admin-only on the server; nothing here is trusted client-side. */
import { api, type Page } from '@/api/client';

export type Role = 'student' | 'teacher' | 'parent';
export type AccountStatus = 'pending' | 'active' | 'suspended';
export interface Person {
  id: number; email: string; full_name: string; role: Role; status: AccountStatus; timezone: string; phone: string;
  level: string; approved: boolean | null; has_password: boolean; date_joined: string; last_login: string | null;
  teachers: { id: number; name: string; assignment_id: number }[];
  guardians: { id: number; name: string; status: string; link_id: number }[];
  children: { id: number; name: string; status: string; link_id: number }[];
}
export interface SetupLink { setup_email_sent: boolean; setup_link: string | null }
export type Counts = Record<AccountStatus | 'all', number> & { unapproved?: number; unlinked?: number };

const qs = (p: Record<string, string | number | undefined>) =>
  Object.entries(p).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

export const listPeople = (p: { role: Role; q?: string; status?: string; page?: number; page_size?: number; unlinked?: string }) =>
  api<Page<Person>>('GET', `admin/users?${qs(p)}`);
export const peopleCounts = (role: Role) => api<Counts>('GET', `admin/users/counts?role=${role}`);
export const getPerson = (id: number) => api<Person>('GET', `admin/users/${id}`);
export const updatePerson = (id: number, patch: Partial<Pick<Person, 'full_name' | 'phone' | 'timezone'>>) => api<Person>('PATCH', `admin/users/${id}`, patch);
export const setPersonStatus = (id: number, status: AccountStatus, reason = '') => api<Person>('POST', `admin/users/${id}/status`, { status, reason });
export const createPerson = (full_name: string, email: string, role: 'student' | 'parent') =>
  api<Person & SetupLink>('POST', 'admin/users', { full_name, email, role });
export const newSetupLink = (id: number) => api<SetupLink>('POST', `admin/users/${id}/setup-link`);
export const setTeacherApproval = (id: number, approved: boolean, reason = '') => api<Person>('POST', `admin/teachers/${id}/approval`, { approved, reason });
export const assignTeacher = (teacher: number, student: number) => api<{ id: number }>('POST', 'admin/teacher-assignments', { teacher, student });
export const endAssignment = (id: number) => api<null>('POST', `admin/teacher-assignments/${id}/end`);
export const linkGuardian = (guardian: number, student: number) => api<{ id: number }>('POST', 'admin/guardian-links', { guardian, student });
export const revokeGuardian = (id: number, reason: string) => api<null>('POST', `admin/guardian-links/${id}/revoke`, { reason });
export const inviteTeacher = (email: string) =>
  api<{ id: number; link: string; expires_at: string }>('POST', 'invitations', { purpose: 'teacher_account', email, days: 7 });

/* ---- Circles, sessions, bookings (prompt 06) ---- */
export type CircleState = 'draft' | 'published' | 'off';
export interface Circle {
  id: number; name: string; teacher: { id: number; name: string }; level: string; capacity: number; schedule_note: string; state: CircleState;
  upcoming_sessions: number; upcoming_booked_seats: number; updated_at: string;
}
export interface SessionRow { id: number; starts_at: string; ends_at: string; status: 'scheduled' | 'cancelled' | 'completed'; capacity: number; booked: number }
export interface PlanItem { starts_at: string; ends_at: string; ok: boolean; problem: string }
export interface Booking {
  id: number; status: 'confirmed' | 'cancelled'; attendance: string; starts_at: string; ends_at: string; kind: 'individual' | 'group';
  circle: string | null; session_status: string; teacher: { id: number; name: string }; student: { id: number; name: string };
  cancel_reason: string; cancelled_at: string | null; cancelled_by: string | null;
}
export const listCircles = (p: { q?: string; state?: string; page?: number }) => api<Page<Circle>>('GET', `admin/circles?${qs(p)}`);
export const getCircle = (id: number) => api<Circle & { sessions: SessionRow[] }>('GET', `admin/circles/${id}`);
export const createCircle = (d: { name: string; teacher: number; capacity: number; level: string; schedule_note: string }) => api<Circle>('POST', 'admin/circles', d);
export const updateCircle = (id: number, d: Partial<{ name: string; capacity: number; level: string; schedule_note: string }>) => api<Circle>('PATCH', `admin/circles/${id}`, d);
export const setCircleState = (id: number, state: CircleState, reason = '') => api<Circle>('POST', `admin/circles/${id}/state`, { state, reason });
export const scheduleCircle = (id: number, d: { weekday: number; time: string; minutes: number; weeks: number; start?: string; timezone: string; dry_run: boolean }) =>
  api<{ dry_run: boolean; created: number; replaced_open_slots: number; timezone: string; plan: PlanItem[] }>('POST', `admin/circles/${id}/sessions`, d);
export const cancelSession = (id: number, reason: string) => api<{ bookings_cancelled: number }>('POST', `admin/sessions/${id}/cancel`, { reason });
export const listBookings = (p: { when: 'upcoming' | 'past'; status?: string; q?: string; page?: number }) => api<Page<Booking>>('GET', `admin/bookings?${qs(p)}`);
export const cancelBooking = (id: number, reason: string) => api<Booking>('POST', `admin/bookings/${id}/cancel`, { reason });
