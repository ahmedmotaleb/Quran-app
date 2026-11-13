/** «الأذكار والأدعية» API (apps.adhkar). Readers only ever receive approved, enabled entries. */
import { api } from '@/api/client';

export interface Dhikr {
  id: number; category: string; category_label: string; text: string; source_type: 'quran' | 'hadith'; source: string;
  repetition: number | null; time_of_day: string; time_label: string; surah: number | null; ayah_from: number | null; ayah_to: number | null;
  hadith_collection: string; hadith_number: string; grading: string; grading_label: string; graded_by: string; reference_url: string;
  favorite?: boolean;
}
export interface AdminDhikr extends Dhikr {
  status: 'pending' | 'approved' | 'rejected'; status_label: string; enabled: boolean; origin: string; created_by: string | null;
  reviewed_by: string | null; reviewed_at: string | null; review_note: string; created_at: string;
}
export interface Category { key: string; label: string; count?: number }
export interface Prefs {
  enabled: boolean; interval_hours: number; window_start: number; window_end: number; morning_on: boolean; morning_hour: number;
  evening_on: boolean; evening_hour: number; sleep_on: boolean; sleep_hour: number; quran_dua_on: boolean; sunnah_dua_on: boolean;
  quiet_start: number; quiet_end: number; timezone: string;
}
export const list = (p: { category?: string; q?: string; favorites?: boolean } = {}) => {
  const qs = new URLSearchParams();
  if (p.category) qs.set('category', p.category);
  if (p.q) qs.set('q', p.q);
  if (p.favorites) qs.set('favorites', '1');
  return api<{ categories: Category[]; results: Dhikr[] }>('GET', `adhkar${qs.toString() ? `?${qs}` : ''}`);
};
export const one = (id: number) => api<Dhikr>('GET', `adhkar/${id}`);
export const favorite = (id: number, on: boolean) => api<{ favorite: boolean }>(on ? 'POST' : 'DELETE', `adhkar/${id}/favorite`);
export const prefs = () => api<Prefs>('GET', 'me/adhkar-settings');
export const savePrefs = (p: Partial<Prefs>) => api<Prefs>('PUT', 'me/adhkar-settings', p);

// administration
export const adminList = (p: { status?: string; category?: string; q?: string; source?: string } = {}) => {
  const qs = new URLSearchParams(Object.entries(p).filter(([, v]) => v) as [string, string][]);
  return api<{ count: number; results: { counts: Record<string, number>; categories: Category[]; rows: AdminDhikr[] } }>('GET', `admin/adhkar${qs.toString() ? `?${qs}` : ''}`);
};
export const adminCreate = (b: Record<string, unknown>) => api<AdminDhikr>('POST', 'admin/adhkar', b);
export const adminEdit = (id: number, b: Record<string, unknown>) => api<AdminDhikr>('PATCH', `admin/adhkar/${id}`, b);
export const adminReview = (id: number, decision: 'approve' | 'reject', note = '') => api<AdminDhikr>('POST', `admin/adhkar/${id}/review`, { decision, note });
export const adminEnable = (id: number, enabled: boolean) => api<AdminDhikr>('POST', `admin/adhkar/${id}/enable`, { enabled });
export const adminSeed = () => api<{ created: number; existing: number; missing: string[] }>('POST', 'admin/adhkar/seed-quran');
export const adminTest = (id: number) => api<{ devices: number; push_status: string; message: string }>('POST', `admin/adhkar/${id}/test`);
export interface Stats {
  notices_7d: number; accounts_7d: number; by_push_status: Record<string, number>; library: Record<string, number>;
  top: { dhikr: number; source: string; sent: number }[]; failed: { at: string; role: string; status: string; error: string; attempts: number; dhikr: number | null }[];
}
export const adminStats = () => api<Stats>('GET', 'admin/adhkar/stats');
