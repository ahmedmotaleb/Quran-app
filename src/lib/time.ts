/** Every user-facing date and time in the app goes through here.
 *  - 12-hour clock with «صباحًا» / «مساءً» and Arabic-Indic digits: 14:30 → «٢:٣٠ مساءً», 09:00 → «٩:٠٠ صباحًا».
 *  - Instants are UTC on the server and shown in an IANA zone: the device's own (`deviceZone()`), so a traveller sees
 *    local times, and Cairo's daylight saving time comes from the IANA database (never a fixed UTC+2/+3).
 *  Pure (no app imports), so `node --experimental-strip-types e2e/time-format.test.mjs` can test it. */
export const DEFAULT_ZONE = 'Africa/Cairo';
export const AM = 'صباحًا';
export const PM = 'مساءً';
const AR = 'ar-EG'; // Arabic month/day names with Arabic-Indic digits
const DIGITS = '٠١٢٣٤٥٦٧٨٩';

export const arDigits = (s: string | number) => String(s).replace(/[0-9]/g, (d) => DIGITS[+d]);

export function validZone(z: unknown): z is string {
  if (typeof z !== 'string' || !z) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; }
}

/** The time zone set on this phone or computer; Africa/Cairo when the browser reports none. */
export function deviceZone(): string {
  try { const z = Intl.DateTimeFormat().resolvedOptions().timeZone; return validZone(z) ? z : DEFAULT_ZONE; } catch { return DEFAULT_ZONE; }
}

/** Wall clock in `tz` at an instant (24-hour numbers). */
export function wallClock(at: string | number | Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute };
}

/** 14, 30 → «٢:٣٠ مساءً»; 0, 0 → «١٢:٠٠ صباحًا»; 12, 0 → «١٢:٠٠ مساءً». */
export function clock(hour: number, minute = 0): string {
  const h = ((hour % 24) + 24) % 24;
  return `${arDigits(((h + 11) % 12) + 1)}:${arDigits(String(minute).padStart(2, '0'))} ${h < 12 ? AM : PM}`;
}
/** "14:30" (or "14:30:00") → «٢:٣٠ مساءً». */
export function clockOf(hhmm: string | null | undefined): string {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return clock(h, m || 0);
}
/** A whole hour as a 12-hour label: 20 → «٨:٠٠ مساءً». */
export const hourLabel = (h: number) => clock(h, 0);

export function fmtTime(iso: string, tz: string): string {
  const w = wallClock(iso, tz);
  return clock(w.hour, w.minute);
}

/** «الثلاثاء ١٣ أكتوبر» */
export function fmtDay(iso: string, tz: string): string {
  return new Intl.DateTimeFormat(AR, { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso)).replace('،', '');
}
/** «الثلاثاء ١٣ أكتوبر، ٢:٣٠ مساءً» */
export const fmtDateTime = (iso: string, tz: string) => `${fmtDay(iso, tz)}، ${fmtTime(iso, tz)}`;
/** «١٣ أكتوبر ٢٠٢٦» */
export const fmtDate = (iso: string, tz: string) => new Intl.DateTimeFormat(AR, { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
/** Compact, for lists: «ثلاثاء ١٣ أكتوبر · ٢:٣٠ مساءً» */
export function fmtShortDateTime(iso: string, tz: string): string {
  const d = new Intl.DateTimeFormat(AR, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso)).replace('،', '');
  return `${d} · ${fmtTime(iso, tz)}`;
}

export function weekdayShort(iso: string, tz: string): string {
  return new Intl.DateTimeFormat(AR, { timeZone: tz, weekday: 'long' }).format(new Date(iso));
}
export function dayNumber(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, day: 'numeric' }).format(new Date(iso));
}

function localDateKey(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** 0 = today, 1 = tomorrow, -1 = yesterday … in the given timezone. */
export function dayOffset(iso: string, tz: string, now = new Date()): number {
  const a = new Date(localDateKey(new Date(iso), tz) + 'T00:00:00Z').getTime();
  const b = new Date(localDateKey(now, tz) + 'T00:00:00Z').getTime();
  return Math.round((a - b) / 86_400_000);
}

export const sameLocalDay = (iso: string, tz: string, key: string) => localDateKey(new Date(iso), tz) === key;
export const dateKey = (iso: string, tz: string) => localDateKey(new Date(iso), tz);

/** «اليوم، ٩:٠٠ مساءً» / «غدًا، …» / «أمس، …» / «الثلاثاء ١٣ أكتوبر» */
export function fmtRelative(iso: string, tz: string, now = new Date()): string {
  const off = dayOffset(iso, tz, now);
  if (off === 0) return `اليوم، ${fmtTime(iso, tz)}`;
  if (off === 1) return `غدًا، ${fmtTime(iso, tz)}`;
  if (off === -1) return `أمس، ${fmtTime(iso, tz)}`;
  return fmtDay(iso, tz);
}
export function dayLabel(iso: string, tz: string): string {
  const off = dayOffset(iso, tz);
  return off === 0 ? 'اليوم' : off === 1 ? 'غدًا' : fmtDay(iso, tz);
}

/** "GMT+2" for the zone at that instant (Cairo: GMT+2 in winter, GMT+3 in summer). */
export function gmtOffset(tz: string, at: number | Date = Date.now()): string {
  const v = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName')?.value;
  return !v || v === 'GMT' ? 'GMT+0' : v;
}
const CITY: Record<string, string> = {
  'Africa/Cairo': 'القاهرة', 'Asia/Riyadh': 'الرياض', 'Asia/Dubai': 'دبي', 'Asia/Kuala_Lumpur': 'كوالالمبور', 'Europe/London': 'لندن',
  'Asia/Kuwait': 'الكويت', 'Asia/Qatar': 'الدوحة', 'Asia/Bahrain': 'البحرين', 'Asia/Muscat': 'مسقط', 'Asia/Amman': 'عمّان',
  'Asia/Baghdad': 'بغداد', 'Asia/Beirut': 'بيروت', 'Asia/Damascus': 'دمشق', 'Asia/Jerusalem': 'القدس', 'Asia/Gaza': 'غزة', 'Asia/Hebron': 'الخليل',
  'Africa/Khartoum': 'الخرطوم', 'Africa/Tripoli': 'طرابلس', 'Africa/Tunis': 'تونس', 'Africa/Algiers': 'الجزائر', 'Africa/Casablanca': 'الدار البيضاء',
  'Asia/Istanbul': 'إسطنبول', 'Europe/Istanbul': 'إسطنبول', 'Europe/Paris': 'باريس', 'Europe/Berlin': 'برلين', 'America/New_York': 'نيويورك',
  'America/Chicago': 'شيكاغو', 'America/Los_Angeles': 'لوس أنجلوس', 'America/Toronto': 'تورونتو', 'Asia/Tokyo': 'طوكيو', 'Asia/Jakarta': 'جاكرتا',
  'Asia/Karachi': 'كراتشي', 'Australia/Sydney': 'سيدني', UTC: 'التوقيت العالمي',
};
/** «القاهرة» for a known zone, else the city part of the IANA name ("America/Denver" → "Denver"). */
export const zoneCity = (tz: string) => CITY[tz] ?? tz.split('/').pop()!.replace(/_/g, ' ');
/** «بتوقيت القاهرة (GMT+2)» */
export const zoneLabel = (tz: string, at?: number | Date) => `بتوقيت ${zoneCity(tz)} (${gmtOffset(tz, at)})`;

/** Wall-clock date ("YYYY-MM-DD") + time ("HH:MM") in an IANA zone → ISO instant (DST-safe). */
export function zonedToIso(date: string, time: string, tz: string): string {
  const [y, mo, d] = date.split('-').map(Number); const [hh, mm] = time.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, hh, mm);
  const offset = (t: number) => { const w = wallClock(t, tz); return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - t; };
  let t = wall - offset(wall);
  t = wall - offset(t);
  return new Date(t).toISOString();
}
