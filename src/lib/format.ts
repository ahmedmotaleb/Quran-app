import { DAYS, TZS } from '@/data/demo';
import { surahLabel } from '@/lib/quranIndex';
import type { BadgeKind, Task, TaskType, TzId } from '@/data/types';
import type { IconName } from '@/components/Icon';
import { color } from '@/theme/tokens';

/** mm:ss — used for every audio/recording timer (always rendered LTR). */
export function fmt(s: number): string {
  s = Math.max(0, Math.floor(s));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const tzBase = (tz: TzId) => TZS.find((t) => t.id === tz)!;

/** Demo "today" (Sunday 11 Oct 2026). Demo slot hours are defined in Riyadh time (UTC+3, no DST). */
const DEMO_DAY_UTC = Date.UTC(2026, 9, 11);
const instantFromRiyadhHour = (h: number) => new Date(DEMO_DAY_UTC + (h - 3) * 3600_000);

/** "GMT+3"-style label for the zone at the demo date, from the IANA database (handles DST). */
function gmtLabel(iana: string): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: iana, timeZoneName: 'shortOffset' })
    .formatToParts(new Date(DEMO_DAY_UTC + 12 * 3600_000)).find((p) => p.type === 'timeZoneName');
  return part?.value === 'GMT' ? 'GMT+0' : (part?.value ?? 'GMT');
}
export const tzOf = (tz: TzId) => { const t = tzBase(tz); return { ...t, gmt: gmtLabel(t.iana) }; };
export const tzLabel = (tz: TzId) => { const t = tzOf(tz); return `بتوقيت ${t.label} (${t.gmt})`; };

/** Formats a demo slot (hour in Riyadh time) as 12h time with ص/م in the viewer's IANA timezone. */
export function timeIn(tz: TzId, h: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tzBase(tz).iana, hour: 'numeric', minute: '2-digit', hour12: true })
    .formatToParts(instantFromRiyadhHour(h));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase() === 'AM' ? 'ص' : 'م'}`;
}

export const dayFull = (i: number) => { const d = DAYS[i]; return `${d[0]} ${d[1]} أكتوبر`; };
export const dayL = (i: number) => (i === 0 ? 'اليوم' : i === 1 ? 'غدًا' : dayFull(i));
export const surahName = (n: number) => surahLabel(n).replace(/^سورة /, ''); // the canonical index (all 114)
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
  needs_repeat: { label: 'مطلوب الإعادة', bg: color.warnBg, fg: color.warnInk, icon: 'repeat' },
  confirmed: { label: 'مؤكدة', bg: color.sage, fg: color.primary, icon: 'check' },
  cancelled: { label: 'ملغاة', bg: color.dangerBg, fg: color.dangerInk, icon: 'x' },
  completed: { label: 'مكتملة', bg: color.neutralBg, fg: color.subtle, icon: 'check' },
  late: { label: 'متأخر', bg: color.dangerBg, fg: color.dangerInk, icon: 'alert' },
  newsub: { label: 'تسليم جديد', bg: color.warnBg, fg: color.warnInk, icon: 'upload' },
};
export const badge = (k: BadgeKind) => BADGES[k];

/** Strips Arabic diacritics so surah search matches plain input. */
export const normalizeArabic = (s: string) => s.replace(/[ً-ْٰۡـ]/g, '').replace(/ٱ/g, 'ا');
