import { TEACHERS } from '@/data/demo';
import type { Session, Task } from '@/data/types';
import { dayFull, dayL, rangeL, timeIn, tzLabel } from '@/lib/format';
import type { AppState } from './store';

export const teacherById = (id: string) => TEACHERS.find((t) => t.id === id)!;

export function decoSession(x: Session, s: AppState) {
  const t = teacherById(x.t);
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

export const upcomingSessions = (s: AppState) =>
  s.sessions.filter((x) => x.status === 'confirmed').map((x) => decoSession(x, s)).sort((a, b) => (a.day! * 100 + a.h) - (b.day! * 100 + b.h));
export const pastSessions = (s: AppState) => s.sessions.filter((x) => x.status !== 'confirmed').map((x) => decoSession(x, s));

/** Today's memorisation task for the home card. */
export function homeHifz(s: AppState): Task | undefined {
  return s.tasks.find((t) => t.today && t.type === 'hifz') || s.tasks.find((t) => t.type === 'hifz' && t.status !== 'reviewed');
}
export const taskRange = rangeL;
