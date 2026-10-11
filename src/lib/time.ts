/** Instant formatting in an IANA timezone, Arabic words with Western digits (0123456789). */
const AR = 'ar-EG-u-nu-latn';

function localDateKey(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function fmtTime(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase() === 'AM' ? 'ص' : 'م'}`;
}

/** "الثلاثاء 13 أكتوبر" */
export function fmtDay(iso: string, tz: string): string {
  return new Intl.DateTimeFormat(AR, { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso)).replace('،', '');
}

export function weekdayShort(iso: string, tz: string): string {
  return new Intl.DateTimeFormat(AR, { timeZone: tz, weekday: 'long' }).format(new Date(iso));
}
export function dayNumber(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, day: 'numeric' }).format(new Date(iso));
}

/** 0 = today, 1 = tomorrow, -1 = yesterday … in the given timezone. */
export function dayOffset(iso: string, tz: string, now = new Date()): number {
  const a = new Date(localDateKey(new Date(iso), tz) + 'T00:00:00Z').getTime();
  const b = new Date(localDateKey(now, tz) + 'T00:00:00Z').getTime();
  return Math.round((a - b) / 86_400_000);
}

export const sameLocalDay = (iso: string, tz: string, key: string) => localDateKey(new Date(iso), tz) === key;
export const dateKey = (iso: string, tz: string) => localDateKey(new Date(iso), tz);

/** "اليوم، 9:00 م" / "غدًا، 9:00 م" / "أمس، 9:00 م" / "الثلاثاء 13 أكتوبر" */
export function fmtRelative(iso: string, tz: string): string {
  const off = dayOffset(iso, tz);
  if (off === 0) return `اليوم، ${fmtTime(iso, tz)}`;
  if (off === 1) return `غدًا، ${fmtTime(iso, tz)}`;
  if (off === -1) return `أمس، ${fmtTime(iso, tz)}`;
  return fmtDay(iso, tz);
}
export function dayLabel(iso: string, tz: string): string {
  const off = dayOffset(iso, tz);
  return off === 0 ? 'اليوم' : off === 1 ? 'غدًا' : fmtDay(iso, tz);
}
