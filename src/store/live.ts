/**
 * Live mode (VITE_API_BASE_URL set): store actions backed by the Django API.
 * Wired: auth (login/register/logout/session restore/forgot), onboarding, profile timezone,
 * student tasks, teacher directory, slots, booking/cancel/reschedule, recording upload + submission,
 * teacher feedback, teacher students/assign/reviews/schedule/attendance/grading, parent app,
 * lessons, quizzes and progress.
 * Not wired (screens keep demo content, labelled): teacher content authoring, live video.
 */
import * as E from '@/api/endpoints';
import { ApiError, api, resetCsrf } from '@/api/client';
import { TZS } from '@/data/demo';
import type { Feedback, Recording, Role, Slot, TzId } from '@/data/types';
import { dayOffset, fmtRelative, zonedToIso } from '@/lib/time';
import { rangeL, tzOf, typeL } from '@/lib/format';
import { SUR } from '@/data/demo';
import { BRAND } from '@/theme/brand';
import * as media from '@/services/media';
import { back, reset, setState, toast, up, useApp, type AssignForm, type Mark, type ReviewDraft, type ReviewItem } from './store';
import { discardVoiceNote, stopVoiceNote, voiceNote, voiceNoteRecording } from '@/services/voiceNote';

// Lazy: store.ts and this module import each other.
const get = () => useApp.getState();
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
    const [a, t, b, sub, ls, ts] = await Promise.all([E.assignments(), E.teachers(), E.bookings(), E.submissions(), E.lessons(), E.tests()]);
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
      fb, recs, avail: {}, subs: sub.results, lessons: ls, tests: ts,
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
    const [st, a, sub, occ, gr] = await Promise.all([E.teacherStudents(), E.assignments(), E.submissions(), E.teacherOccurrences(), E.gradingQueue()]);
    const tz = iana();
    const reviews: ReviewItem[] = sub.results.map((x) => ({
      id: String(x.id), taskId: String(x.assignment), student: x.student_name, sid: String(x.student), title: x.assignment_title,
      range: rangeL({ s: x.surah, from: x.ayah_from, to: x.ayah_to }), dur: x.duration_seconds, url: x.audio?.url ?? null,
      at: fmtRelative(x.created_at, tz), status: x.feedback ? 'reviewed' : 'submitted',
    }));
    setState((s) => ({
      students: st.results.map(E.toStudent), tasks: a.results.map((x) => E.toTask(x, tz)), reviews, tsched: occ, grading: gr,
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

/** Admin-managed settings the learner app follows (cancel window, open sign-up, recording length, support). */
export async function loadPublicSettings() {
  try { const p = await E.publicSettings(); setState({ pub: { ...get().pub, ...p } }); } catch { /* keep defaults */ }
}

/** On startup: restore the session (cookie on web, stored token on Android). Runs once even if called twice
 * (React StrictMode re-runs effects in development), so a late duplicate can't yank the user back to home. */
let booting: Promise<boolean> | null = null;
export function bootstrap(): Promise<boolean> {
  booting ??= restoreSession();
  return booting;
}
async function restoreSession(): Promise<boolean> {
  void loadPublicSettings();
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
    const r = await E.login(email, password);
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
    const r = await E.register(name, email, password, Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Cairo');
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
  resetCsrf();
  // Nothing from the previous account stays in memory.
  setState({ me: null, tasks: [], sessions: [], fb: {}, recs: {}, avail: {}, reviews: null, students: [], teachers: [], parent: null, tsched: null, subs: [], lessons: null, lessonCur: null, tests: null, lq: null, grading: null });
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
    if (voiceNoteRecording()) await stopVoiceNote();
    // The optional voice note is uploaded first (private media); a failed upload stops the send, keeping the note.
    const voice = voiceNote.blob ? (await E.uploadVoiceNote(voiceNote.blob, voiceNote.secs)).id : null;
    await E.giveFeedback(+r.id, {
      score_hifz: v.ratings.hifz, score_tajweed: v.ratings.tajweed, score_fluency: v.ratings.fluency,
      decision: v.decision === 'approve' ? 'accept' : 'repeat', general: v.general.trim(), needs_review: v.needs.trim(),
      next_step: '', notes: v.notes.map((n) => ({ at_seconds: n.t, text: n.text })), voice,
    });
    discardVoiceNote();
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

/* ---------------- lessons & quizzes ---------------- */
export async function openLesson(id: number) {
  setState({ lessonCur: null });
  try { setState({ lessonCur: await E.lesson(id) }); } catch (e) { toast(msg(e), 'alert'); }
}
export async function completeLesson(id: number) {
  try {
    await E.completeLesson(id);
    setState((s) => ({
      lessons: s.lessons?.map((l) => (l.id === id ? { ...l, completed: true } : l)) ?? null,
      lessonCur: s.lessonCur?.id === id ? { ...s.lessonCur, completed: true } : s.lessonCur,
    }));
    toast('أحسنت، سُجّل الدرس كمكتمل');
  } catch (e) { toast(msg(e), 'alert'); }
}

/** Starts (or resumes) an attempt. The server decides limits and the deadline. */
export async function startQuiz(testId: number) {
  try {
    const [t, a] = await Promise.all([E.testDetail(testId), E.startAttempt(testId)]);
    setState({ lq: { test: t, questions: t.questions ?? [], attempt: a.id, answers: {}, result: null, busy: false } });
    return true;
  } catch (e) { toast(msg(e), 'alert'); return false; }
}
export async function openResult(testId: number, attemptId: number) {
  try {
    const [t, r] = await Promise.all([E.testDetail(testId), E.attempt(attemptId)]);
    setState({ lq: { test: t, questions: t.questions ?? [], attempt: attemptId, answers: {}, result: r, busy: false } });
    return true;
  } catch (e) { toast(msg(e), 'alert'); return false; }
}
export const answerQuiz = (qid: number, v: unknown) => setState((s) => (s.lq ? { lq: { ...s.lq, answers: { ...s.lq.answers, [qid]: v } } } : {}));

/** Uploads any recitation recordings, then submits every answer in one request (idempotent on the server). */
export async function submitQuiz(recordings: Record<number, { blob: Blob; secs: number }>) {
  const q = get().lq; if (!q || q.busy) return;
  setState({ lq: { ...q, busy: true } });
  try {
    const answers: { question: number; response?: unknown; recording?: string }[] = [];
    for (const x of q.questions) {
      if (x.kind === 'recitation') {
        const r = recordings[x.id];
        if (r) answers.push({ question: x.id, recording: (await E.uploadRecitation(r.blob, r.secs)).id });
      } else if (q.answers[x.id] !== undefined) answers.push({ question: x.id, response: q.answers[x.id] });
    }
    const result = await E.submitAttempt(q.attempt, answers);
    setState((s) => ({ lq: s.lq && { ...s.lq, result, busy: false } }));
    try { setState({ tests: await E.tests() }); } catch { /* list refresh is best effort */ }
  } catch (e) {
    setState((s) => ({ lq: s.lq && { ...s.lq, busy: false } }));
    toast(msg(e), 'alert');
  }
}

export async function gradeRecitation(answerId: number, points: number, reason: string) {
  try {
    await E.gradeAnswer(answerId, points, reason);
    toast('حُفظت الدرجة');
    setState({ grading: await E.gradingQueue() });
  } catch (e) { toast(msg(e), 'alert'); }
}


/* ---------- Mushaf: reading position, bookmarks, source (pack prompt 20) ---------- */
let posTimer: ReturnType<typeof setTimeout> | null = null;
let lastSaved = '';

export async function enterMushaf(requested: number | null) {
  const { loadSurah, jumpTo } = await import('./store');
  api<{ name: string; edition: string; narration: string; version: string; license: string; attribution: string; url: string }>('GET', 'quran/source')
    .then((src) => up('m', { src })).catch(() => {});
  loadMarks();
  if (requested) { loadSurah(requested); return; }
  try {
    const pos = await api<{ surah: number | null; ayah: number | null }>('GET', 'quran/position');
    if (pos.surah && pos.ayah) {
      lastSaved = `${pos.surah}:${pos.ayah}`;
      await loadSurah(pos.surah);
      if (pos.ayah > 1) jumpTo(pos.ayah);
      return;
    }
  } catch { /* offline or not signed in: open the current surah */ }
  loadSurah(get().m.surah);
}

/** Called as the reader scrolls; saves at most every 1.5 s, and only when the place changed. */
export function notePosition(surah: number, ayah: number) {
  const key = `${surah}:${ayah}`;
  if (key === lastSaved) return;
  if (posTimer) clearTimeout(posTimer);
  posTimer = setTimeout(() => {
    lastSaved = key;
    api('PUT', 'quran/position', { surah, ayah }).catch(() => { lastSaved = ''; });
  }, 1500);
}

export async function loadMarks() {
  try { up('m', { marks: await api<Mark[]>('GET', 'quran/bookmarks') }); } catch { /* keep what we have */ }
}
export async function addMark(surah: number, ayah: number) {
  try { await api('POST', 'quran/bookmarks', { surah, ayah }); toast(`حُفظت العلامة عند الآية ${ayah}`, 'bookmark'); await loadMarks(); }
  catch (e) { toast(msg(e), 'alert'); }
}
export async function removeMark(id: number) {
  try { await api('DELETE', `quran/bookmarks/${id}`); toast('أُزيلت العلامة', 'bookmark'); await loadMarks(); }
  catch (e) { toast(msg(e), 'alert'); }
}
export async function labelMark(id: number, label: string) {
  try { await api('PATCH', `quran/bookmarks/${id}`, { label }); await loadMarks(); toast('حُفظ الوصف', 'bookmark'); }
  catch (e) { toast(msg(e), 'alert'); }
}
