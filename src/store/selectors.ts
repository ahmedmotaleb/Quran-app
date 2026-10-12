import { TEACHERS } from '@/data/demo';
import type { Session, Slot, Task, Teacher } from '@/data/types';
import { dayFull, dayL, rangeL, timeIn, tzLabel, tzOf } from '@/lib/format';
import { dayLabel, dayNumber, fmtDay, fmtTime, weekdayShort } from '@/lib/time';
import { DAYS } from '@/data/demo';
import { useApp, type AppState } from './store';

const UNKNOWN: Teacher = { id: '', name: 'المعلم', ini: '؟', spec: '—', tags: [], types: ['فردية'], levels: '—', aud: '—', bio: '' };
/** Teachers come from the store: demo list, or the API directory in live mode. */
export const teacherById = (id: string): Teacher =>
  useApp.getState().teachers.find((t) => t.id === id) ?? TEACHERS.find((t) => t.id === id) ?? UNKNOWN;

export const ianaOf = (s: Pick<AppState, 'tz'>) => tzOf(s.tz).iana;

/** Time label for a slot: real instant in live mode, demo Riyadh-hour otherwise. */
export const slotTime = (s: AppState, x: Slot) => (x.iso ? fmtTime(x.iso, ianaOf(s)) : timeIn(s.tz, x.h));

/** The 7 day chips: real dates from today in live mode, the demo week otherwise. */
export function weekDays(s: AppState): { label: string; num: string; full: string }[] {
  if (!s.liveMode) return DAYS.map((d, i) => ({ label: i === 0 ? 'اليوم' : d[0], num: String(d[1]), full: dayFull(i) }));
  const tz = ianaOf(s);
  return Array.from({ length: 7 }, (_, i) => {
    const iso = new Date(Date.now() + i * 86_400_000).toISOString();
    return { label: i === 0 ? 'اليوم' : weekdayShort(iso, tz), num: dayNumber(iso, tz), full: fmtDay(iso, tz) };
  });
}

export function decoSession(x: Session, s: AppState) {
  const t = teacherById(x.t);
  if (x.startsAt) {
    const tz = ianaOf(s);
    const timeL = fmtTime(x.startsAt, tz);
    return {
      ...x, teacherName: x.teacherName ?? t.name, ini: t.ini, timeL, tzL: tzLabel(s.tz),
      when: `${dayLabel(x.startsAt, tz)} · ${timeL}`, dateFull: fmtDay(x.startsAt, tz),
      isToday: !!x.canJoin && x.status === 'confirmed',
      notToday: !x.canJoin && x.status === 'confirmed',
      active: x.status === 'confirmed',
      taskL: x.task ? s.tasks.find((k) => k.id === x.task)?.title ?? '' : 'بدون مهمة محددة',
    };
  }
  const today = x.day === 0 && !x.past;
  const timeL = timeIn(s.tz, x.h);
  return {
    ...x, teacherName: t.name, ini: t.ini, timeL, tzL: tzLabel(s.tz),
    when: x.past ? `${x.past} · ${timeL}` : `${dayL(x.day!)} · ${timeL}`,
    dateFull: x.past || dayFull(x.day!),
    isToday: today && x.status === 'confirmed',
    notToday: !today && x.status === 'confirmed',
    active: x.status === 'confirmed',
    taskL: x.task ? s.tasks.find((k) => k.id === x.task)?.title ?? '' : 'بدون مهمة محددة',
  };
}
export type DecoSession = ReturnType<typeof decoSession>;

const order = (x: Session) => (x.startsAt ? new Date(x.startsAt).getTime() : x.day! * 100 + x.h);
export const upcomingSessions = (s: AppState) =>
  s.sessions.filter((x) => x.status === 'confirmed').sort((a, b) => order(a) - order(b)).map((x) => decoSession(x, s));
export const pastSessions = (s: AppState) =>
  s.sessions.filter((x) => x.status !== 'confirmed').sort((a, b) => (a.startsAt && b.startsAt ? order(b) - order(a) : 0)).map((x) => decoSession(x, s));

/** Today's memorisation task for the home card. */
export function homeHifz(s: AppState): Task | undefined {
  return s.tasks.find((t) => t.today && t.type === 'hifz') || s.tasks.find((t) => t.type === 'hifz' && t.status !== 'reviewed');
}
export const taskRange = rangeL;
