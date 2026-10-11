/**
 * Live mode (VITE_API_BASE_URL set): store actions backed by the Django API.
 * Wired: auth (login/register/logout/session restore/forgot), onboarding, profile timezone,
 * student tasks, teacher directory, slots, booking/cancel/reschedule.
 * Not wired yet (screens keep demo content, labelled): teacher & parent dashboards,
 * recording upload (needs object storage), feedback details, lessons, quizzes, progress.
 */
import * as E from '@/api/endpoints';
import { ApiError, IS_NATIVE, loadToken, resetCsrf, setToken } from '@/api/client';
import { TZS } from '@/data/demo';
import type { Role, Slot, TzId } from '@/data/types';
import { dayOffset } from '@/lib/time';
import { tzOf } from '@/lib/format';
import { BRAND } from '@/theme/brand';
import { reset, setState, toast, up, useApp } from './store';

// Lazy: store.ts and this module import each other.
const get = () => useApp.getState();
const client = () => (IS_NATIVE ? 'native' : 'web') as 'web' | 'native';
const iana = () => tzOf(get().tz).iana;
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'حدث خطأ غير متوقع. حاول مرة أخرى.');

const tzIdFor = (zone: string): TzId => TZS.find((t) => t.iana === zone)?.id ?? 'cairo';
const homeFor = (r: Role) => (r === 'student' ? 'home' : r === 'teacher' ? 'tdash' : 'phome');

function applyUser(u: E.Me) {
  const name = u.full_name || u.email;
  setState((s) => ({
    me: u, tz: tzIdFor(u.timezone),
    user: { ...s.user, name, first: name.split(' ')[0], email: u.email, level: u.level || '—', goal: u.daily_goal || '—' },
  }));
}

/** Loads everything the student screens need. Failures leave an error flag the screens show. */
export async function loadStudentData() {
  if (get().me?.role !== 'student') return;
  setState({ net: { ...get().net, loading: true, error: null } });
  try {
    const [a, t, b] = await Promise.all([E.assignments(), E.teachers(), E.bookings()]);
    const tz = iana();
    setState((s) => ({
      tasks: a.results.map((x) => E.toTask(x, tz)),
      teachers: t.results.map(E.toTeacher),
      sessions: b.results.map(E.toSession),
      fb: {}, recs: {}, avail: {},
      net: { ...s.net, loading: false, error: null },
    }));
  } catch (e) {
    setState((s) => ({ net: { ...s.net, loading: false, error: msg(e) } }));
  }
}

/** On startup: restore the session (cookie on web, stored token on Android). */
export async function bootstrap(): Promise<boolean> {
  await loadToken();
  try {
    const u = await E.me();
    if (u.role === 'admin') return false;
    applyUser(u);
    reset(homeFor(u.role), u.role);
    await loadStudentData();
    return true;
  } catch {
    return false;
  }
}

export async function login(email: string, password: string) {
  up('login', { loading: true, errors: {} });
  try {
    const r = await E.login(email, password, client());
    if (r.token) await setToken(r.token);
    resetCsrf();
    applyUser(r.user);
    up('login', { loading: false, pw: '' });
    reset(homeFor(r.user.role), r.user.role);
    await loadStudentData();
  } catch (e) {
    const err = e as ApiError;
    const field = err.code === 'bad_credentials' || err.code === 'account_pending' || err.code === 'account_suspended' || err.code === 'admin_portal_only' ? 'email' : null;
    up('login', { loading: false, errors: { email: err.field?.('email') ?? (field ? err.message : null), pw: err.field?.('password') ?? null } });
    if (!field && !err.fields?.email && !err.fields?.password) toast(msg(e), 'alert');
  }
}

export async function register(name: string, email: string, password: string) {
  try {
    const r = await E.register(name, email, password, client(), Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Cairo');
    if (r.token) await setToken(r.token);
    resetCsrf();
    applyUser(r.user);
    setState((s) => ({ signup: { ...s.signup, errors: {}, pw: '' }, ob: { ...s.ob, step: 0 } }));
    reset('onboard', 'student');
  } catch (e) {
    const err = e as ApiError;
    up('signup', { errors: { name: err.field?.('full_name') ?? null, email: err.field?.('email') ?? null, pw: err.field?.('password') ?? null } });
    if (!err.fields || !Object.keys(err.fields).length) toast(msg(e), 'alert');
  }
}

export async function finishOnboarding(level: string, goal: string, days: string[], period: string) {
  try {
    applyUser(await E.saveOnboarding({ level, daily_goal: goal, preferred_days: days, preferred_period: period }));
    reset('home', 'student');
    toast(`تم إعداد خطتك. مرحبًا بك في ${BRAND.ar}`);
    await loadStudentData();
  } catch (e) {
    up('ob', { error: msg(e) });
  }
}

export async function forgot(email: string) {
  try {
    await E.forgot(email);
    up('forgot', { sent: true, errors: {} });
  } catch (e) {
    up('forgot', { errors: { email: msg(e) } });
  }
}

export async function logout() {
  try { await E.logout(); } catch { /* signing out locally regardless */ }
  await setToken(null);
  resetCsrf();
  setState({ me: null });
}

export async function saveTimezone(id: TzId) {
  const zone = TZS.find((t) => t.id === id)!.iana;
  try { applyUser(await E.updateMe({ timezone: zone })); await loadStudentData(); } catch (e) { toast(msg(e), 'alert'); }
}

export async function startTask(id: string) {
  try {
    const a = await E.startAssignment(+id);
    setState((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? E.toTask(a, iana()) : t)) }));
  } catch { /* the recorder still works; the status catches up on the next refresh */ }
}

/* ---------------- booking ---------------- */
const KIND = { individual: 'فردية', group: 'جماعية' } as const;

/** Fetches open slots and lays them out as the 7-day grid the screen renders. */
export async function loadSlots(teacherId: string) {
  up('bk', { loading: true, error: null });
  try {
    const list = await E.slots(+teacherId);
    const tz = iana();
    const days: Slot[][] = Array.from({ length: 7 }, () => []);
    for (const o of list) {
      const d = dayOffset(o.starts_at, tz);
      if (d < 0 || d > 6) continue;
      const [hh, mm] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .format(new Date(o.starts_at)).split(':').map(Number);
      days[d].push({ h: hh + mm / 60, taken: o.seats_left <= 0, occ: o.id, iso: o.starts_at, kind: KIND[o.kind] });
    }
    days.forEach((d) => d.sort((a, b) => a.h - b.h));
    const first = days.findIndex((d) => d.some((x) => !x.taken));
    setState((s) => ({ avail: { ...s.avail, [teacherId]: days }, bk: { ...s.bk, loading: false, day: first < 0 ? 0 : first } }));
  } catch (e) {
    setState((s) => ({ avail: { ...s.avail, [teacherId]: Array.from({ length: 7 }, () => []) }, bk: { ...s.bk, loading: false, error: msg(e) } }));
  }
}

function selectedSlot(): Slot | undefined {
  const b = get().bk;
  return get().avail[b.t]?.[b.day]?.find((x) => x.h === b.h && (!x.kind || x.kind === b.type));
}

/** Books (or reschedules). The Idempotency-Key is kept per chosen slot, so a retried tap never double-books. */
export async function confirm(): Promise<string | null> {
  const b = get().bk; const slot = selectedSlot();
  if (!slot?.occ) return null;
  const key = b.key?.occ === slot.occ ? b.key.key : E.newIdempotencyKey();
  up('bk', { key: { occ: slot.occ, key }, busy: true, error: null });
  try {
    const res = b.resched
      ? await E.reschedule(+b.resched, slot.occ, key)
      : await E.book(slot.occ, key, b.task ? +b.task : null, b.note);
    up('bk', { busy: false, key: null });
    await loadStudentData();
    return String(res.id);
  } catch (e) {
    const err = e as ApiError;
    up('bk', { busy: false, error: msg(e), key: err.status && err.status < 500 ? null : get().bk.key });
    if (['slot_taken', 'slot_unavailable', 'too_late'].includes(err.code)) loadSlots(b.t);
    return null;
  }
}

export async function cancel(id: string) {
  try {
    await E.cancelBooking(+id);
    await loadStudentData();
    toast('تم إلغاء الحجز');
  } catch (e) {
    toast(msg(e), 'alert');
  }
}
