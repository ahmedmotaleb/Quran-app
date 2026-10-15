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
