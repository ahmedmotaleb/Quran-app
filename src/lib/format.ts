import { DAYS, SUR, TZS } from '@/data/demo';
import type { BadgeKind, Task, TaskType, TzId } from '@/data/types';
import type { IconName } from '@/components/Icon';
import { color } from '@/theme/tokens';

/** mm:ss — used for every audio/recording timer (always rendered LTR). */
export function fmt(s: number): string {
  s = Math.max(0, Math.floor(s));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export const tzOf = (tz: TzId) => TZS.find((t) => t.id === tz)!;
export const tzLabel = (tz: TzId) => { const t = tzOf(tz); return `بتوقيت ${t.label} (${t.gmt})`; };

/** Formats an hour stored in Riyadh time (GMT+3) into the viewer's timezone, 12h with ص/م. */
export function timeIn(tz: TzId, h: number): string {
  let x = h + tzOf(tz).off - 3;
  x = ((x % 24) + 24) % 24;
  const hh = Math.floor(x), mm = Math.round((x - hh) * 60);
  const h12 = hh % 12 || 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'ص' : 'م'}`;
}

export const dayFull = (i: number) => { const d = DAYS[i]; return `${d[0]} ${d[1]} أكتوبر`; };
export const dayL = (i: number) => (i === 0 ? 'اليوم' : i === 1 ? 'غدًا' : dayFull(i));
export const surahName = (n: number) => (SUR[n] || ['سورة'])[0];
export const rangeL = (t: Pick<Task, 's' | 'from' | 'to'>) => `سورة ${surahName(t.s)} · الآيات ${t.from}–${t.to}`;
export const typeL = (t: TaskType) => ({ hifz: 'حفظ', review: 'مراجعة', tajweed: 'تجويد' })[t];
export const typeIcon = (t: TaskType): IconName => ({ hifz: 'book', review: 'repeat', tajweed: 'volume' } as const)[t];
export const scoreL = (n: number) => ['', 'ضعيف', 'مقبول', 'جيد', 'جيد جدًا', 'ممتاز'][n] || '—';

export interface BadgeSpec { label: string; bg: string; fg: string; icon: IconName }
const BADGES: Record<BadgeKind, BadgeSpec> = {
  not_started: { label: 'لم تبدأ', bg: color.neutralBg, fg: color.subtle, icon: 'circle' },
  in_progress: { label: 'قيد التنفيذ', bg: color.warnBg, fg: color.warnInk, icon: 'clock' },
  submitted: { label: 'تم التسليم', bg: color.sage, fg: color.primary, icon: 'upload' },
  reviewed: { label: 'تمت المراجعة', bg: color.primary, fg: color.ivory, icon: 'check' },
  confirmed: { label: 'مؤكدة', bg: color.sage, fg: color.primary, icon: 'check' },
  cancelled: { label: 'ملغاة', bg: color.dangerBg, fg: color.dangerInk, icon: 'x' },
  completed: { label: 'مكتملة', bg: color.neutralBg, fg: color.subtle, icon: 'check' },
  late: { label: 'متأخر', bg: color.dangerBg, fg: color.dangerInk, icon: 'alert' },
  newsub: { label: 'تسليم جديد', bg: color.warnBg, fg: color.warnInk, icon: 'upload' },
};
export const badge = (k: BadgeKind) => BADGES[k];

/** Strips Arabic diacritics so surah search matches plain input. */
export const normalizeArabic = (s: string) => s.replace(/[ً-ْٰۡـ]/g, '').replace(/ٱ/g, 'ا');
