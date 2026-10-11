/**
 * Live mode (VITE_API_BASE_URL set): store actions backed by the Django API.
 * Wired: auth (login/register/logout/session restore/forgot), onboarding, profile timezone,
 * student tasks, teacher directory, slots, booking/cancel/reschedule.
 * recording upload + submission, teacher feedback (student view), teacher students/assign/reviews.
 * Not wired yet (screens keep demo content, labelled): parent app, teacher schedule & content,
 * live video, lessons, quizzes, progress.
 */
import * as E from '@/api/endpoints';
import { ApiError, IS_NATIVE, loadToken, resetCsrf, setToken } from '@/api/client';
import { TZS } from '@/data/demo';
import type { Feedback, Recording, Role, Slot, TzId } from '@/data/types';
import { dayOffset, fmtRelative, zonedToIso } from '@/lib/time';
import { rangeL, tzOf, typeL } from '@/lib/format';
import { SUR } from '@/data/demo';
import { BRAND } from '@/theme/brand';
import * as media from '@/services/media';
import { back, reset, setState, toast, up, useApp, type AssignForm, type ReviewDraft, type ReviewItem } from './store';

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
    const [a, t, b, sub] = await Promise.all([E.assignments(), E.teachers(), E.bookings(), E.submissions()]);
    const tz = iana();
    // Newest first: the first submission seen per task is its latest attempt.
    const fb: Record<string, Feedback> = {}; const recs: Record<string, Recording> = {};
    for (const x of sub.results) {
      const k = String(x.assignment);
      if (recs[k]) continue;
      recs[k] = { dur: x.duration_seconds, url: x.audio?.url ?? null };
      if (x.feedback) fb[k] = E.toFeedback(x.feedback, x.duration_seconds, tz);
    }
    setState((s) => ({
      tasks: a.results.map((x) => E.toTask(x, tz)),
      teachers: t.results.map(E.toTeacher),
      sessions: b.results.map(E.toSession),
      fb, recs, avail: {},
      net: { ...s.net, loading: false, error: null },
    }));
  } catch (e) {
    setState((s) => ({ net: { ...s.net, loading: false, error: msg(e) } }));
  }
}

/** Teacher app: assigned students, their tasks, and the review queue. */
export async function loadTeacherData() {
  if (get().me?.role !== 'teacher') return;
  setState({ net: { ...get().net, loading: true, error: null } });
  try {
    const [st, a, sub, occ] = await Promise.all([E.teacherStudents(), E.assignments(), E.submissions(), E.teacherOccurrences()]);
    const tz = iana();
    const reviews: ReviewItem[] = sub.results.map((x) => ({
      id: String(x.id), taskId: String(x.assignment), student: x.student_name, sid: String(x.student), title: x.assignment_title,
      range: rangeL({ s: x.surah, from: x.ayah_from, to: x.ayah_to }), dur: x.duration_seconds, url: x.audio?.url ?? null,
      at: fmtRelative(x.created_at, tz), status: x.feedback ? 'reviewed' : 'submitted',
    }));
    setState((s) => ({
      students: st.results.map(E.toStudent), tasks: a.results.map((x) => E.toTask(x, tz)), reviews, tsched: occ,
      net: { ...s.net, loading: false, error: null },
    }));
  } catch (e) {
    setState((s) => ({ net: { ...s.net, loading: false, error: msg(e) } }));
  }
}

/** Parent: only children with an active guardian link come back from the API. */
export async function loadParentData() {
  if (get().me?.role !== 'parent') return;
  setState({ net: { ...get().net, loading: true, error: null } });
  try {
    const [k, a, b, sub] = await Promise.all([E.parentChildren(), E.assignments(), E.bookings(), E.submissions()]);
    const tz = iana();
    const kids = k.results.map((x) => ({ id: String(x.id), name: x.full_name, level: x.level || '—' }));
    setState((s) => ({
      parent: { kids, tasks: a.results.map((x) => E.toTask(x, tz)), bookings: b.results, subs: sub.results },
      child: kids.some((x) => x.id === s.child) ? s.child : kids[0]?.id ?? '',
      net: { ...s.net, loading: false, error: null },
    }));
  } catch (e) {
    setState((s) => ({ net: { ...s.net, loading: false, error: msg(e) } }));
  }
}

export const loadData = () => {
  const r = get().me?.role;
  return r === 'teacher' ? loadTeacherData() : r === 'parent' ? loadParentData() : loadStudentData();
};

/** On startup: restore the session (cookie on web, stored token on Android). */
export async function bootstrap(): Promise<boolean> {
  await loadToken();
  try {
    const u = await E.me();
    if (u.role === 'admin') return false;
    applyUser(u);
    reset(homeFor(u.role), u.role);
    await loadData();
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
    await loadData();
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
  // Nothing from the previous account stays in memory.
  setState({ me: null, tasks: [], sessions: [], fb: {}, recs: {}, avail: {}, reviews: null, students: [], teachers: [], parent: null, tsched: null });
}

export async function saveTimezone(id: TzId) {
  const zone = TZS.find((t) => t.id === id)!.iana;
  try { applyUser(await E.updateMe({ timezone: zone })); await loadData(); } catch (e) { toast(msg(e), 'alert'); }
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

/* ---------------- recordings ---------------- */
/**
 * Uploads the recording, then submits it. The Idempotency-Key and the uploaded media id are kept
 * on the recorder state, so "retry" after a failure never uploads twice or submits twice.
 */
export async function submitRecording() {
  const r = get().rec;
  const blob = media.recording.blob;
  if (!r.mediaId && !blob) {
    up('rec', { phase: 'failed', err: 'لا يوجد تسجيل صوتي حقيقي لرفعه. سجّل بالميكروفون ثم أعد المحاولة.' });
    return;
  }
  const key = r.key ?? E.newIdempotencyKey();
  up('rec', { phase: 'uploading', prog: 5, key, err: null });
  try {
    let mediaId = r.mediaId;
    if (!mediaId) { mediaId = (await E.uploadRecitation(blob!, r.secs)).id; up('rec', { mediaId, prog: 70 }); }
    const sub = await E.submit(+r.task, mediaId, key);
    setState((s) => ({
      rec: { ...s.rec, phase: 'success', prog: 100, key: null, mediaId: null },
      tasks: s.tasks.map((t) => (t.id === r.task ? { ...t, status: 'submitted', at: 'الآن' } : t)),
      recs: { ...s.recs, [r.task]: { dur: sub.duration_seconds, url: sub.audio?.url ?? media.recording.url } },
    }));
  } catch (e) {
    const err = e as ApiError;
    // A rejected file needs a new recording; a network/server error can be retried as is.
    if (err.status >= 400 && err.status < 500 && err.code !== 'not_submittable') up('rec', { mediaId: null });
    up('rec', { phase: 'failed', err: msg(e) });
  }
}

/* ---------------- teacher ---------------- */
export async function sendFeedback(v: ReviewDraft, r: ReviewItem) {
  try {
    await E.giveFeedback(+r.id, {
      score_hifz: v.ratings.hifz, score_tajweed: v.ratings.tajweed, score_fluency: v.ratings.fluency,
      decision: v.decision === 'approve' ? 'accept' : 'repeat', general: v.general.trim(), needs_review: v.needs.trim(),
      next_step: '', notes: v.notes.map((n) => ({ at_seconds: n.t, text: n.text })),
    });
    back();
    toast(`أُرسل التقييم إلى ${r.student}`);
    await loadTeacherData();
  } catch (e) {
    const err = e as ApiError;
    if (err.fields && Object.keys(err.fields).length) up('rv', { errors: { needs: err.field('needs_review') } });
    toast(msg(e), 'alert');
  }
}

const DUE_DAYS = { today: 0, tomorrow: 1, in3: 3, week: 7 } as const;

export async function createAssignment(f: AssignForm) {
  const tz = iana();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() + DUE_DAYS[f.due] * 86_400_000));
  const name = SUR[+f.s][0];
  const stu = get().students.find((x) => x.id === f.sid);
  try {
    await E.createAssignment({
      student: +f.sid, kind: f.type, title: f.type === 'tajweed' ? 'تجويد: سورة ' + name : `${typeL(f.type)} سورة ${name}`,
      surah: +f.s, ayah_from: +f.from, ayah_to: +f.to, instructions: f.instr.trim(), due_at: zonedToIso(day, f.time || '21:00', tz),
      requires_recording: f.needRec,
    });
    back();
    toast(`أُرسل الواجب إلى ${stu?.name ?? 'الطالب'}`);
    await loadTeacherData();
  } catch (e) {
    const err = e as ApiError;
    up('af', { errors: { from: err.field?.('ayah_from') ?? null, to: err.field?.('ayah_to') ?? null } });
    toast(msg(e), 'alert');
  }
}

/* ---------------- teacher schedule ---------------- */
async function refreshSchedule() {
  try { setState({ tsched: await E.teacherOccurrences() }); } catch (e) { toast(msg(e), 'alert'); }
}

/** Opens (on) or closes (off) the slot at a local date + "HH:MM" in the teacher's timezone. */
export async function toggleSlot(dateKey: string, hhmm: string, existingId: number | null) {
  try {
    if (existingId) { await E.closeSlot(existingId); toast('أُغلق الموعد', 'cal'); }
    else { await E.openSlot(zonedToIso(dateKey, hhmm, iana())); toast('فُتح الموعد للحجز', 'cal'); }
  } catch (e) { toast(msg(e), 'alert'); }
  await refreshSchedule();
}

export async function setAttendance(bookingId: number, value: string) {
  try { await E.markAttendance(bookingId, value); toast('حُفظ الحضور'); } catch (e) { toast(msg(e), 'alert'); }
  await refreshSchedule();
}

export async function teacherCancelBooking(bookingId: number) {
  try { await E.cancelBooking(bookingId, 'ألغاه المعلم'); toast('أُلغي الحجز وأُبلغ الطالب'); } catch (e) { toast(msg(e), 'alert'); }
  await refreshSchedule();
}
