/** Typed API calls and adapters from server records to the screens' data shapes. */
import type { Session, Task, TaskStatus, Teacher } from '@/data/types';
import { fmtRelative } from '@/lib/time';
import { api, newIdempotencyKey, type Page } from './client';

export type ApiRole = 'student' | 'teacher' | 'parent' | 'admin';
export interface Me {
  id: number; email: string; full_name: string; role: ApiRole; status: string; timezone: string; phone: string;
  mfa_enabled: boolean; level: string; daily_goal: string;
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
}

// ---- auth ----
export const login = (email: string, password: string, client: 'web' | 'native') =>
  api<LoginResult>('POST', 'auth/login', { email, password, client, device: client === 'native' ? 'android' : '' });
export const register = (full_name: string, email: string, password: string, client: 'web' | 'native', timezone: string) =>
  api<LoginResult>('POST', 'auth/register', { full_name, email, password, client, timezone });
export const logout = () => api<null>('POST', 'auth/logout');
export const me = () => api<Me>('GET', 'me');
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
export const cancelBooking = (id: number, reason = '') => api<ApiBooking>('POST', `bookings/${id}/cancel`, { reason });
export const reschedule = (id: number, occurrence: number, key: string) =>
  api<ApiBooking>('POST', `bookings/${id}/reschedule`, { occurrence }, { idempotencyKey: key });
export { newIdempotencyKey };

// ---- adapters ----
const STATUS: Record<ApiAssignment['status'], TaskStatus> = {
  not_started: 'not_started', in_progress: 'in_progress', submitted: 'submitted', accepted: 'reviewed', needs_repeat: 'needs_repeat',
};

export function toTask(a: ApiAssignment, tz: string): Task {
  return {
    id: String(a.id), type: a.kind, title: a.title, s: a.surah, from: a.ayah_from, to: a.ayah_to,
    due: fmtRelative(a.due_at, tz), dueAt: a.due_at, status: STATUS[a.status], instr: a.instructions || 'لا توجد توجيهات إضافية.',
    today: fmtRelative(a.due_at, tz).startsWith('اليوم'), teacherName: a.teacher_name,
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
    task: b.assignment ? String(b.assignment) : null, note: b.note, startsAt: o.starts_at, endsAt: o.ends_at, canJoin: b.can_join,
  };
}
