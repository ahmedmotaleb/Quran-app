import { create } from 'zustand';
import {
  ACCOUNTS, QUIZ, SUR, STUDENTS, TEACHERS, generateAvailability, initialFeedback, initialOthers, initialRecordings, initialSessions, initialTasks,
  type Screen,
} from '@/data/demo';
import type {
  Availability, Decision, Feedback, OtherSubmission, Recording, Role, Scores, Session, SurahData, SurahListItem, Student, Task, TaskStatus, TaskType, Teacher, TimedNote, TzId,
} from '@/data/types';
import { rangeL, typeL } from '@/lib/format';
import { ayahAudioUrl, currentReciter, fetchSurah, fetchSurahList, hasSurahAudio, loadSurahAudio, saveReciter } from '@/services/quran';
import { ApiError } from '@/api/client';
import * as media from '@/services/media';
import type { IconName } from '@/components/Icon';
import { BRAND } from '@/theme/brand';
import { LIVE } from '@/api/client';
import type { ApiBooking, ApiGradingItem, ApiLesson, ApiQuestion, ApiResult, ApiSubmission, ApiTeacherOcc, ApiTest, Me } from '@/api/endpoints';
import * as live from './live';
import { discardVoiceNote } from '@/services/voiceNote';

/* ------------------------------------------------------------------ */
/* State shape                                                          */
/* ------------------------------------------------------------------ */
export interface Params { id?: string; task?: string; s?: number; from?: number; to?: number; rid?: string }
export type DataState = 'normal' | 'loading' | 'empty' | 'error' | 'offline';
export type DeviceKey = '390' | '360' | 'tablet';
export type Sheet =
  | { kind: 'confirm'; title: string; body: string; ok: string; danger?: boolean; onOk: () => void }
  | { kind: 'info'; title: string; body: string }
  | { kind: 'ayah'; n: number }
  | { kind: 'surahs' }
  | { kind: 'bookmarks' }
  | { kind: 'tz' };

export type RecPhase = 'idle' | 'requesting' | 'denied' | 'recording' | 'paused' | 'review' | 'empty' | 'uploading' | 'failed' | 'success';
export type LivePhase = 'waiting' | 'connecting' | 'live' | 'reconnecting' | 'failed' | 'ended';

export interface ReviewDraft {
  rid: string; notes: TimedNote[]; ratings: Scores; decision: Decision; needs: string; general: string;
  voice: number | null; voiceRec: boolean; voiceSecs: number; draft: string | null; draftAt?: number; errors: Record<string, string | null>;
}
export interface AssignForm {
  sid: string; type: TaskType; s: string; from: string; to: string; due: 'today' | 'tomorrow' | 'in3' | 'week';
  time: string; instr: string; needRec: boolean; errors: Record<string, string | null>;
}
export interface MushafState {
  surah: number; data: SurahData | null; loading: boolean; error: boolean; errMsg?: string | null; from: number; to: number; font: number;
  /** repeat: times to play the range (0 = continuously); rate: playback speed; adv: carry on past the range end. */
  bookmark: number | null; playing: boolean; cur: number | null; repeat: number; rep: number; jump: string; rate: number; adv: boolean;
  list: SurahListItem[] | null; listQ: string; listErr: boolean; flash: number | null;
  /** bumped when the reciter changes (the choice itself lives in localStorage) */
  reciterV?: number;
  /** Live mode: the reader's saved bookmarks (all surahs) and the verified source's details. */
  marks: Mark[] | null; src: SourceInfo | null;
}
export interface Mark { id: number; surah: number; ayah: number; label: string }
export interface SourceInfo { name: string; edition: string; narration: string; version: string; license: string; attribution: string; url: string }

/** Live recorder state: the retry-safe submission key and the already-uploaded file. */
const REC_LIVE = { live: LIVE, key: null as string | null, mediaId: null as string | null, err: null as string | null };

const initial = () => ({
  /** True when a backend is configured (VITE_API_BASE_URL); demo data otherwise. */
  liveMode: LIVE,
  /** Public platform settings from the server (live mode); safe defaults until loaded. */
  pub: { cancel_hours: 12, open_signup: true, max_recording_seconds: 900, join_minutes: 10, ayah_audio: null as import('@/api/endpoints').AyahAudioCfg | null, org_name: '', support_email: '', support_whatsapp: '', show_support_button: false },
  me: null as Me | null,
  net: { loading: false, error: null as string | null },
  // Live mode starts empty: demo records must never appear (even briefly) before the server's data arrives.
  teachers: (LIVE ? [] : [...TEACHERS]) as Teacher[],
  students: (LIVE ? [] : [...STUDENTS]) as Student[],
  /** Live mode: the teacher's review queue from the API (demo derives it from tasks). */
  reviews: null as ReviewItem[] | null,
  /** Live mode, teacher: own sessions (with bookings) for the coming week. */
  tsched: null as ApiTeacherOcc[] | null,
  /** Live mode: all of the student's submissions (progress), the library, tests, and the teacher's grading queue. */
  subs: [] as ApiSubmission[],
  lessons: null as ApiLesson[] | null,
  lessonCur: null as ApiLesson | null,
  tests: null as ApiTest[] | null,
  /** Live quiz: the open test, its attempt, local answers (by question id) and the server result. */
  lq: null as null | { test: ApiTest; questions: ApiQuestion[]; attempt: number; answers: Record<number, unknown>; result: ApiResult | null; busy: boolean },
  grading: null as ApiGradingItem[] | null,
  /** Live mode, parent: linked children and their records (the API scopes all of it). */
  parent: null as null | { kids: { id: string; name: string; level: string }[]; tasks: Task[]; bookings: ApiBooking[]; subs: ApiSubmission[] },
  role: null as Role | null,
  screen: 'splash' as Screen,
  params: {} as Params,
  stack: [] as { screen: Screen; params: Params }[],
  ds: 'normal' as DataState,
  toast: null as { text: string; icon: IconName } | null,
  sheet: null as Sheet | null,
  device: '390' as DeviceKey,
  user: { name: 'يوسف أحمد', first: 'يوسف', email: 'yousef@halqa.app', level: 'متوسط', goal: '5 أسطر يوميًا' },
  tz: 'cairo' as TzId,
  uiScale: 'm' as 's' | 'm' | 'l',
  notif: { tasks: true, sessions: true, feedback: true, news: false } as Record<string, boolean>,
  intro: 0,
  /** `parent`: the «تسجيل دخول ولي الأمر» entry. Only wording changes; the server decides the role and the portal. */
  login: { email: '', pw: '', show: false, errors: {} as Record<string, string | null>, loading: false, parent: false },
  signup: { name: '', email: '', pw: '', errors: {} as Record<string, string | null> },
  forgot: { email: '', sent: false, errors: {} as Record<string, string | null> },
  ob: { step: 0, level: null as string | null, goal: null as string | null, days: ['الأحد', 'الثلاثاء', 'الخميس'], period: 'مساءً', error: null as string | null },
  planTab: 'hifz' as TaskType,
  circTab: 'teachers' as 'teachers' | 'bookings' | 'lessons' | 'quizzes',
  q: '', filt: 'all', lessonTopic: 'all', progRange: 'month' as 'week' | 'month' | 'q',
  tasks: LIVE ? [] : initialTasks(),
  fb: initialFeedback() as Record<string, Feedback>,
  recs: initialRecordings() as Record<string, Recording>,
  sessions: (LIVE ? [] : initialSessions()) as Session[],
  avail: generateAvailability() as Availability,
  others: initialOthers() as OtherSubmission[],
  bk: {
    t: 't1', type: 'فردية', day: 0, h: null as number | null, note: '', task: 'k1' as string | null, error: null as string | null, resched: null as string | null,
    /** Live mode: request state and the Idempotency-Key for the chosen slot. */
    loading: false, busy: false, key: null as null | { occ: number; key: string },
  },
  rec: { phase: 'idle' as RecPhase, secs: 0, task: 'k1', demo: false, prog: 0, ...REC_LIVE },
  player: { key: null as string | null, pos: 0, dur: 0, playing: false },
  m: { surah: 67, data: null, loading: false, error: false, from: 1, to: 10, font: 26, bookmark: null, playing: false, cur: null, repeat: 1, rep: 0, rate: 1, adv: false, jump: '', list: null, listQ: '', listErr: false, flash: null, marks: null, src: null } as MushafState,
  live: { phase: 'waiting' as LivePhase, mic: true, cam: true, secs: 0, count: 272, attempt: 0, taskOpen: true, c: 0 },
  sim: { uploadFail: false, slotTaken: false },
  rv: null as ReviewDraft | null,
  rvTab: 'pending' as 'pending' | 'done',
  af: null as AssignForm | null,
  stuQ: '', stuF: 'all',
  sched: { tab: 'sessions' as 'sessions' | 'avail', day: 0 },
  tc: { kind: 'lecture' as 'lecture' | 'quiz', title: '', topic: 'التجويد', level: 'مبتدئ', file: null as string | null, qs: [] as { text: string; rec: boolean }[], errors: {} as Record<string, string | null> },
  child: 'u1',
  quiz: null as null | { id: string; phase: 'intro' | 'q' | 'result'; idx: number; ans: Record<number, number>; rec: boolean; submitted: boolean },
  lessonDone: {} as Record<string, boolean>,
  notifyMe: {} as Record<string, boolean>,
});

export type AppState = ReturnType<typeof initial>;
export const useApp = create<AppState>(() => initial());

const get = useApp.getState;
const set = useApp.setState;
export const setState = set;
type Obj = Record<string, unknown>;
/** Shallow-merge into a nested state object. */
export function up<K extends keyof AppState>(k: K, o: Partial<NonNullable<AppState[K]>>) {
  set((s) => ({ [k]: { ...(s[k] as Obj), ...(o as Obj) } }) as Partial<AppState>);
}
const setM = (o: Partial<MushafState>) => up('m', o);

/* ------------------------------------------------------------------ */
/* Navigation                                                           */
/* ------------------------------------------------------------------ */
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let splashTimer: ReturnType<typeof setTimeout> | undefined;

function leave(): Partial<AppState> {
  media.stopMushafAudio();
  media.stopPlayback();
  const s = get();
  return { player: { ...s.player, playing: false }, m: { ...s.m, playing: false, cur: null }, sheet: null };
}
function scrollTop() {
  requestAnimationFrame(() => { const e = document.getElementById('scr'); if (e) e.scrollTop = 0; });
}

/*
 * Phone back button / gesture (installed PWA): each in-app step pushes a browser history entry, so
 * "back" walks the app's stack instead of closing it. The URL is unchanged (admin keeps its #/admin).
 */
let skipPop = false;
const inApp = () => !location.hash.startsWith('#/');
function pushNav() { if (inApp()) history.pushState({ halqa: true }, ''); }
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    if (!inApp()) return;
    if (skipPop) { skipPop = false; return; }
    const s = get();
    if (s.sheet) { set({ sheet: null }); pushNav(); return; }   // back closes an open sheet first
    if (s.stack.length) popScreen();
  });
}

export function go(screen: Screen, params: Params = {}) {
  const x = leave();
  set((s) => ({ ...x, stack: [...s.stack, { screen: s.screen, params: s.params }], screen, params }));
  scrollTop();
  onEnter(screen, params);
  pushNav();
}
/** On-screen back arrow: pop the app stack and keep browser history in step. */
export function back() {
  const had = get().stack.length > 0;
  popScreen();
  if (had && inApp() && history.state?.halqa) { skipPop = true; history.back(); }
}
function popScreen() {
  const x = leave();
  set((s) => {
    const st = [...s.stack]; const p = st.pop();
    return p ? { ...x, stack: st, screen: p.screen, params: p.params } : x;
  });
  scrollTop();
}
/** Bottom-nav switch: clears history. */
export function tab(screen: Screen) {
  set({ ...leave(), screen, params: {}, stack: [] });
  scrollTop();
}
export function reset(screen: Screen, role: Role | null, extra: Partial<AppState> = {}) {
  set({ ...leave(), screen, role, params: {}, stack: [], ...extra });
  scrollTop();
  onEnter(screen, {});
}
/** Replace current screen without pushing history. */
export function replace(screen: Screen, params: Params) {
  set({ ...leave(), screen, params });
  scrollTop();
}
export function toast(text: string, icon: IconName = 'check') {
  clearTimeout(toastTimer);
  set({ toast: { text, icon } });
  toastTimer = setTimeout(() => set({ toast: null }), 3000);
}
export const openSheet = (sheet: Sheet) => set({ sheet });
export const closeSheet = () => set({ sheet: null });

function onEnter(screen: Screen, p: Params) {
  if (screen === 'mushaf') {
    if (p.from) setM({ from: p.from, to: p.to });
    if (LIVE) live.enterMushaf(p.s ?? null);  // reopens at the reader's saved position when no range was asked for
    else loadSurah(p.s || get().m.surah);
  }
  if (screen === 'record') {
    media.discardRecorder();
    set((s) => ({ rec: { phase: 'idle', secs: 0, task: p.task || s.rec.task || 'k1', demo: false, prog: 0, ...REC_LIVE } }));
  }
  if (screen === 'live') set({ live: { phase: 'waiting', mic: true, cam: true, secs: 0, count: 272, attempt: 0, taskOpen: true, c: 0 } });
}

export function startSplash() {
  clearTimeout(splashTimer);
  splashTimer = setTimeout(() => { if (get().screen === 'splash') set({ screen: get().login.parent ? 'login' : 'intro' }); }, 2000);
  // Live: a still-valid session (cookie or stored token) goes straight to the app.
  if (LIVE) live.bootstrap();
}
export function skipSplash() { clearTimeout(splashTimer); set({ screen: 'intro' }); }
export function restartSplash() { reset('splash', null); startSplash(); }

/* ------------------------------------------------------------------ */
/* Clock: drives players, recorder timer, fake upload, live session.    */
/* ------------------------------------------------------------------ */
export function tick() {
  const s = get(); const o: Partial<AppState> = {};
  const p = s.player;
  if (p.playing) {
    const el = media.playback.el;
    const pos = el && !el.paused ? el.currentTime : p.pos + 0.25;
    o.player = pos >= p.dur ? { ...p, pos: p.dur, playing: false } : { ...p, pos };
  }
  const r = s.rec;
  if (r.phase === 'recording') {
    o.rec = { ...r, secs: r.secs + 0.25 };
    // The admin's maximum recording length (live mode): stop cleanly instead of failing on upload.
    if (s.liveMode && r.secs + 0.25 >= s.pub.max_recording_seconds) { setTimeout(() => { stopRec(); toast(`وصلت إلى أقصى مدة للتسجيل (${Math.round(s.pub.max_recording_seconds / 60)} دقيقة).`); }, 0); }
  }
  if (r.phase === 'uploading' && s.liveMode) {
    // Real upload: creep towards 90% until the server answers (fetch has no upload progress).
    if (r.prog < 90) o.rec = { ...r, prog: r.prog + (90 - r.prog) * 0.04 };
  } else if (r.phase === 'uploading') {
    const prog = Math.min(100, r.prog + 7);
    if (prog >= 100) {
      if (s.sim.uploadFail) o.rec = { ...r, prog: 100, phase: 'failed' };
      else {
        o.rec = { ...r, prog: 100, phase: 'success' };
        o.tasks = s.tasks.map((t) => (t.id === r.task ? { ...t, status: 'submitted' as TaskStatus, at: 'اليوم الآن' } : t));
        o.recs = { ...s.recs, [r.task]: { dur: r.secs, url: media.recording.url } };
      }
    } else o.rec = { ...r, prog };
  }
  if (s.rv?.voiceRec) o.rv = { ...s.rv, voiceSecs: s.rv.voiceSecs + 0.25 };
  const L = s.live;
  if (s.screen === 'live') {
    if (L.phase === 'waiting' && L.count > 0) o.live = { ...L, count: L.count - 0.25 };
    if (L.phase === 'connecting') { const c = L.c + 1; o.live = c >= 6 ? { ...L, phase: 'live', c: 0 } : { ...L, c }; }
    if (L.phase === 'live') o.live = { ...L, secs: L.secs + 0.25 };
    if (L.phase === 'reconnecting') {
      const c = L.c + 1;
      if (c >= 8) {
        const a = L.attempt + 1;
        if (a >= 3) { o.live = { ...L, phase: 'live', c: 0, attempt: 0, secs: L.secs + 2 }; setTimeout(() => toast('عاد الاتصال، تابع الجلسة'), 0); }
        else o.live = { ...L, attempt: a, c: 0 };
      } else o.live = { ...L, c };
    }
  }
  if (Object.keys(o).length) set(o);
}

/* ------------------------------------------------------------------ */
/* Shared player                                                        */
/* ------------------------------------------------------------------ */
export function playerToggle(key: string, dur: number, url?: string | null) {
  const p = get().player;
  if (p.key === key) {
    if (p.playing) { media.stopPlayback(); up('player', { playing: false }); }
    else {
      const pos = p.pos >= p.dur ? 0 : p.pos;
      const el = media.playback.el;
      if (el) { el.currentTime = pos; el.play().catch(() => {}); }
      up('player', { playing: true, pos });
    }
  } else {
    media.stopMushafAudio();
    media.replacePlayback(url);
    set({ player: { key, dur, pos: 0, playing: true } });
  }
}
export function playerSeek(key: string, dur: number, t: number) {
  const p = get().player;
  if (media.playback.el && p.key === key) media.playback.el.currentTime = t;
  set({ player: { key, dur, pos: Math.min(t, dur), playing: p.key === key ? p.playing : false } });
}

/* ------------------------------------------------------------------ */
/* Recorder                                                             */
/* ------------------------------------------------------------------ */
function markInProgress() {
  const s0 = get(); const t0 = s0.tasks.find((t) => t.id === s0.rec.task);
  if (s0.liveMode) { if (t0 && (t0.status === 'not_started' || t0.status === 'needs_repeat')) live.startTask(t0.id); return; }
  set((s) => ({ tasks: s.tasks.map((t) => (t.id === s.rec.task && t.status === 'not_started' ? { ...t, status: 'in_progress' } : t)) }));
}
export async function startRec() {
  media.discardRecorder();
  up('rec', { phase: 'requesting', secs: 0, demo: false });
  markInProgress();
  try {
    await media.startRecorder(finishRec);
    up('rec', { phase: 'recording', secs: 0 });
  } catch {
    up('rec', { phase: 'denied' });
  }
}
export function demoRec() { media.discardRecorder(); up('rec', { phase: 'recording', secs: 0, demo: true }); markInProgress(); }
export function pauseRec() { media.pauseRecorder(); up('rec', { phase: 'paused' }); }
export function resumeRec() { media.resumeRecorder(); up('rec', { phase: 'recording' }); }
export function stopRec() { if (!media.stopRecorder()) finishRec(); }
function finishRec() {
  const secs = get().rec.secs;
  if (secs < 3) up('rec', { phase: 'empty' });
  else { up('rec', { phase: 'review' }); set({ player: { key: 'rec', dur: secs, pos: 0, playing: false } }); }
}
export function resetRec() { media.discardRecorder(); up('rec', { phase: 'idle', secs: 0 }); }
/** Simulated upload — progress is driven by tick(); nothing leaves the device. */
export function submitRec() {
  media.stopPlayback(); up('player', { playing: false });
  if (get().ds === 'offline') { up('rec', { phase: 'failed' }); return; }
  if (get().liveMode) { live.submitRecording(); return; }
  up('rec', { phase: 'uploading', prog: 0 });
}

/* ------------------------------------------------------------------ */
/* Mushaf                                                               */
/* ------------------------------------------------------------------ */
export async function loadSurah(n: number) {
  setM({ loading: true, error: false, errMsg: null, surah: n });
  try {
    const d = await fetchSurah(n);
    const m = get().m;
    if (m.surah === n) setM({ loading: false, data: d, from: Math.min(m.from, d.numberOfAyahs), to: Math.min(m.to, d.numberOfAyahs) });
  } catch (e) {
    // The server's message for `quran_unavailable` says the verified source isn't available.
    const code = (e as { code?: string }).code;
    setM({ loading: false, error: true, data: null, errMsg: code === 'quran_unavailable' ? (e as Error).message : null });
  }
}
export async function loadSurahList() {
  if (get().m.list) return;
  setM({ listErr: false });
  try { setM({ list: await fetchSurahList() }); }
  catch { setM({ listErr: true, list: Object.keys(SUR).map((k) => ({ n: +k, name: 'سورة ' + SUR[+k][0], c: SUR[+k][1] })) }); }
}
export function stopMushaf() { media.stopMushafAudio(); setM({ playing: false, cur: null }); }
export function playAyah(a: number, rep: number) {
  const m = get().m; media.stopMushafAudio(); media.stopPlayback();
  const cfg = get().pub.ayah_audio; const rid = currentReciter(cfg)?.id ?? null;
  if (cfg?.provider === 'qf' && !hasSurahAudio(m.surah, rid)) {
    // Normally fetched when the surah opens; if not yet, fetch now and start once the list is here.
    setM({ playing: true, cur: a, rep });
    loadSurahAudio(m.surah, rid).then(() => { if (get().m.playing && get().m.cur === a) playAyah(a, rep); })
      .catch((e) => { setM({ playing: false, cur: null }); toast(e instanceof ApiError ? e.message : 'تعذّر تحميل التلاوة. تحقق من الاتصال.', 'alert'); });
    return;
  }
  const src = ayahAudioUrl(m.surah, a, cfg, rid);
  if (!src) {
    setM({ playing: false, cur: null });
    toast(cfg ? 'لا تتوفر تلاوة لهذه الآية.' : 'التلاوة الصوتية متوقفة حتى اعتماد مصدر مرخّص.', 'alert'); return;
  }
  const au = new Audio(src); media.mushafAudio.el = au; au.playbackRate = m.rate;
  const fail = () => {
    if (media.mushafAudio.el !== au) return;
    media.stopMushafAudio(); setM({ playing: false, cur: null });
    toast('تعذّر تشغيل الصوت. تحقق من الاتصال.', 'alert');
  };
  au.onended = () => {
    const mm = get().m; const last = mm.data?.numberOfAyahs ?? mm.to;
    const fullRange = rep + 1 >= mm.repeat && mm.repeat !== 0;
    if (a < mm.to) playAyah(a + 1, rep);
    else if (!fullRange) playAyah(mm.from, rep + 1);                       // next pass (0 = continuous)
    else if (mm.adv && a < last) playAyah(a + 1, rep);                      // auto-advance past the range, once each
    else { media.stopMushafAudio(); setM({ playing: false, cur: null, rep: 0 }); }
  };
  au.onerror = fail; au.play().catch(fail);
  setM({ playing: true, cur: a, rep });
  document.getElementById('ayah-' + a)?.scrollIntoView({ block: 'center', behavior: 'smooth' });  // follow the reciter
}
/** Switch reciter: stops what is playing; the choice is remembered on this device. */
export function setReciter(id: number) {
  stopMushaf(); saveReciter(id); setM({ reciterV: (get().m.reciterV ?? 0) + 1 });
}
/** Speed applies at once to the ayah playing now and to the next ones. */
export function setMushafRate(rate: number) { setM({ rate }); if (media.mushafAudio.el) media.mushafAudio.el.playbackRate = rate; }
export function jumpTo(raw: string | number) {
  const m = get().m; if (!m.data) return;
  const n = parseInt(String(raw), 10);
  if (!n || n < 1 || n > m.data.numberOfAyahs) { toast(`أدخل رقم آية بين 1 و ${m.data.numberOfAyahs}`, 'alert'); return; }
  setM({ flash: n });
  setTimeout(() => {
    const sc = document.getElementById('scr'), el = document.getElementById('ayah-' + n);
    if (sc && el) sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 140;
  }, 30);
  setTimeout(() => setM({ flash: null }), 2200);
}
/** Open a surah at an ayah (e.g. a bookmark in another surah) and bring that ayah into view. */
export async function openAt(surah: number, ayah: number) {
  set({ sheet: null }); media.stopMushafAudio();
  setM({ playing: false, cur: null, from: ayah, to: ayah });
  if (get().m.surah !== surah || !get().m.data) await loadSurah(surah);
  jumpTo(ayah);
}
export function pickSurah(x: SurahListItem) {
  set({ sheet: null }); media.stopMushafAudio();
  setM({ from: 1, to: Math.min(10, x.c), playing: false, cur: null, bookmark: null });
  loadSurah(x.n);
}

/* ------------------------------------------------------------------ */
/* Auth & onboarding (simulated)                                        */
/* ------------------------------------------------------------------ */
const EMAIL_RE = /^\S+@\S+\.\S+$/;
/** The server enforces 10 (Django MinimumLengthValidator); the demo keeps the design's 8. */
export const PW_MIN = LIVE ? 10 : 8;
export function doLogin() {
  const L = get().login; const e: Record<string, string> = {}; const em = L.email.trim().toLowerCase();
  if (!em) e.email = 'أدخل بريدك الإلكتروني'; else if (!EMAIL_RE.test(em)) e.email = 'صيغة البريد الإلكتروني غير صحيحة';
  if (!L.pw) e.pw = 'أدخل كلمة المرور'; else if (!LIVE && L.pw.length < 6) e.pw = 'كلمة المرور 6 أحرف على الأقل';
  if (LIVE) { if (Object.keys(e).length) up('login', { errors: e }); else live.login(em, L.pw); return; }
  if (!e.email && ACCOUNTS[em] === 'admin') e.email = 'حساب الإدارة يدخل من بوابة الإدارة المنفصلة.';
  else if (!e.email && !ACCOUNTS[em]) e.email = 'لا يوجد حساب بهذا البريد. جرّب أحد الحسابات التجريبية أدناه.';
  if (Object.keys(e).length) { up('login', { errors: e }); return; }
  up('login', { loading: true, errors: {} });
  setTimeout(() => {
    const role = ACCOUNTS[em]; up('login', { loading: false });
    reset(role === 'student' ? 'home' : role === 'teacher' ? 'tdash' : 'phome', role);
  }, 700);
}
export function doSignup() {
  const S = get().signup; const e: Record<string, string> = {}; const em = S.email.trim().toLowerCase();
  if (S.name.trim().length < 2) e.name = 'أدخل اسمك الكامل';
  if (!em) e.email = 'أدخل بريدك الإلكتروني'; else if (!EMAIL_RE.test(em)) e.email = 'صيغة البريد الإلكتروني غير صحيحة';
  else if (!LIVE && ACCOUNTS[em]) e.email = 'هذا البريد مسجّل بالفعل. سجّل الدخول بدلًا من ذلك.';
  if (S.pw.length < PW_MIN) e.pw = `استخدم ${PW_MIN} أحرف على الأقل`;
  if (Object.keys(e).length) { up('signup', { errors: e }); return; }
  if (LIVE) { live.register(S.name.trim(), em, S.pw); return; }
  const name = S.name.trim();
  set((s) => ({ user: { ...s.user, name, first: name.split(' ')[0], email: em }, signup: { ...s.signup, errors: {} }, ob: { ...s.ob, step: 0 } }));
  // Public sign-up only ever grants the student role.
  reset('onboard', 'student');
}
export function doForgot() {
  const em = get().forgot.email.trim();
  if (!EMAIL_RE.test(em)) { up('forgot', { errors: { email: em ? 'صيغة البريد الإلكتروني غير صحيحة' : 'أدخل بريدك الإلكتروني' } }); return; }
  if (LIVE) { live.forgot(em); return; }
  up('forgot', { sent: true, errors: {} });
}
export function obNext() {
  const o = get().ob;
  if (o.step === 0 && !o.level) { up('ob', { error: 'اختر مستواك للمتابعة' }); return; }
  if (o.step === 1 && !o.goal) { up('ob', { error: 'اختر هدفك اليومي للمتابعة' }); return; }
  if (o.step === 2 && !o.days.length) { up('ob', { error: 'اختر يومًا واحدًا على الأقل' }); return; }
  if (o.step < 2) { up('ob', { step: o.step + 1, error: null }); return; }
  if (LIVE) { live.finishOnboarding(o.level!, o.goal!, o.days, o.period); return; }
  set((s) => ({ user: { ...s.user, level: o.level!, goal: o.goal! } }));
  reset('home', 'student');
  toast(`تم إعداد خطتك. مرحبًا بك في ${BRAND.ar}`);
}
export async function logout() {
  const wasParent = get().role === 'parent';
  set({ sheet: null });
  // Live mode: the sign-in screen appears only after the server has ended the session, so reopening or
  // refreshing right away cannot restore the old account.
  if (LIVE) await live.logout();
  reset('login', null, { login: { email: '', pw: '', show: false, errors: {}, loading: false, parent: wasParent } });
}
/** `#/parent` link (e.g. in the setup email or a bookmark): open the parent sign-in. A signed-in session is unaffected. */
export function parentLoginEntry() {
  up('login', { parent: true, errors: {} });
  const sc = get().screen;
  if (sc === 'intro' || sc === 'login' || sc === 'signup' || sc === 'forgot') set({ screen: 'login', stack: [], params: {} });
}
const CHILD_KEY = 'halqa.parent.child';
/** The parent's selected child is remembered on this device (an id only; every request is still checked server-side). */
export function pickChild(id: string) {
  set({ child: id });
  try { localStorage.setItem(CHILD_KEY, id); } catch { /* storage unavailable */ }
}
export function rememberedChild(): string | null {
  try { return localStorage.getItem(CHILD_KEY); } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* Booking (simulated persistence)                                      */
/* ------------------------------------------------------------------ */
const markSlot = (avail: Availability, t: string, day: number, h: number, taken: boolean): Availability =>
  ({ ...avail, [t]: avail[t].map((d, i) => (i === day ? d.map((x) => (x.h === h ? { ...x, taken } : x)) : d)) });

const firstOpenTask = () => get().tasks.find((t) => t.status !== 'reviewed' && t.status !== 'submitted')?.id ?? null;
export function openTeacher(teacherId: string, types: string[], firstDay: number) {
  set({ bk: { t: teacherId, type: types[0], day: firstDay, h: null, note: '', task: LIVE ? firstOpenTask() : 'k1', error: null, resched: null, loading: false, busy: false, key: null } });
  go('teacher', { id: teacherId });
  if (LIVE) live.loadSlots(teacherId);
}
function bookingDone(id: string) {
  // Drop teacher + review screens from history so "back" from confirmation lands where booking started.
  set((st) => ({ ...leave(), screen: 'bkdone', params: { id }, stack: st.stack.slice(0, Math.max(0, st.stack.length - 2)) }));
  scrollTop();
}
export function confirmBooking() {
  const s = get(); const b = s.bk;
  if (b.h === null || b.busy) return;
  if (LIVE) { live.confirm().then((id) => { if (id) bookingDone(id); }); return; }
  if (s.sim.slotTaken) {
    set({ bk: { ...b, error: 'لم يعد هذا الموعد متاحًا؛ حجزه طالب آخر قبل قليل. اختر موعدًا آخر.' }, avail: markSlot(s.avail, b.t, b.day, b.h, true), sim: { ...s.sim, slotTaken: false } });
    return;
  }
  let id: string;
  let sessions = [...s.sessions];
  if (b.resched) {
    id = b.resched;
    sessions = sessions.map((x) => (x.id === id ? { ...x, day: b.day, h: b.h!, type: b.type } : x));
  } else {
    id = 's' + Date.now();
    sessions.push({ id, t: b.t, day: b.day, h: b.h, type: b.type, dur: b.type === 'جماعية' ? 60 : 45, status: 'confirmed', task: b.task, note: b.note });
  }
  set({ sessions, avail: markSlot(s.avail, b.t, b.day, b.h, true) });
  bookingDone(id);
}
export function cancelSession(x: Session) {
  if (LIVE) { set({ sheet: null }); live.cancel(x.id); return; }
  set((st) => ({
    sheet: null,
    sessions: st.sessions.map((y) => (y.id === x.id ? { ...y, status: 'cancelled' } : y)),
    avail: x.day !== undefined ? markSlot(st.avail, x.t, x.day, x.h, false) : st.avail,
  }));
  toast('تم إلغاء الحجز');
}
export function rescheduleSession(x: Session) {
  set({ bk: { t: x.t, type: x.type, day: x.day || 0, h: null, note: '', task: x.task, error: null, resched: x.id, loading: false, busy: false, key: null } });
  go('teacher', { id: x.t });
  if (LIVE) live.loadSlots(x.t);
}

/* ------------------------------------------------------------------ */
/* Teacher review                                                       */
/* ------------------------------------------------------------------ */
export interface ReviewItem {
  id: string; taskId?: string; student: string; sid: string; title: string; range: string; dur: number; url?: string | null; at: string;
  status: 'submitted' | 'reviewed'; surah?: number; from?: number; to?: number;
}
/** All submissions visible to the teacher: Yousef's live tasks + other demo students. Pending first. */
export function selectReviews(s: AppState): ReviewItem[] {
  if (s.liveMode) return s.reviews ?? [];
  const mine: ReviewItem[] = s.tasks.filter((t) => t.status === 'submitted' || t.status === 'reviewed').map((t) => ({
    id: 'y-' + t.id, taskId: t.id, student: 'يوسف أحمد', sid: 'u1', title: t.title, range: rangeL(t),
    dur: s.recs[t.id]?.dur || 120, url: s.recs[t.id]?.url, at: t.at || 'أمس', status: t.status as 'submitted' | 'reviewed',
  }));
  const all = [...mine, ...s.others];
  return [...all.filter((r) => r.status === 'submitted'), ...all.filter((r) => r.status === 'reviewed')];
}
export function openReview(rid: string) {
  discardVoiceNote(); // a note recorded for another submission never carries over
  set({ rv: { rid, notes: [], ratings: { hifz: 0, tajweed: 0, fluency: 0 }, decision: 'approve', needs: '', general: '', voice: null, voiceRec: false, voiceSecs: 0, draft: null, errors: {} } });
  go('treview', { rid });
}
export function sendReview() {
  const s = get(); const v = s.rv!; const e: Record<string, string> = {};
  (['hifz', 'tajweed', 'fluency'] as const).forEach((k) => { if (!v.ratings[k]) e[k] = 'اختر درجة'; });
  if (v.decision === 'redo' && !v.needs.trim()) e.needs = 'حدّد ما يحتاج الطالب إلى إعادته';
  if (Object.keys(e).length) { up('rv', { errors: e }); toast('أكمل الحقول المطلوبة قبل الإرسال', 'alert'); return; }
  const r = selectReviews(s).find((x) => x.id === v.rid)!;
  if (LIVE) { live.sendFeedback(v, r); return; }
  if (r.taskId) {
    const taskId = r.taskId;
    set((st) => ({
      tasks: st.tasks.map((t) => (t.id === taskId ? { ...t, status: 'reviewed' } : t)),
      fb: { ...st.fb, [taskId]: {
        teacher: 't1', date: 'اليوم', dur: r.dur, scores: { ...v.ratings }, decision: v.decision,
        notes: [...v.notes].sort((a, b) => a.t - b.t), voice: v.voice, general: v.general.trim() || '—', needs: v.needs.trim() || 'لا يوجد',
        next: v.decision === 'approve' ? 'انتقل إلى النطاق التالي في خطتك.' : 'أعد تسجيل المواضع المحددة وأرسلها للمعلم.',
      } },
    }));
  } else set((st) => ({ others: st.others.map((o) => (o.id === r.id ? { ...o, status: 'reviewed' } : o)) }));
  back();
  toast(`أُرسل التقييم إلى ${r.student}`);
}
/** Demo panel: pretend the teacher reviewed the latest submission. */
export function simEval() {
  const s = get();
  const t = s.tasks.find((x) => x.status === 'submitted' && x.id === 'k1') || s.tasks.find((x) => x.status === 'submitted');
  if (!t) { toast('لا يوجد تسليم بانتظار التقييم', 'alert'); return; }
  const dur = s.recs[t.id]?.dur || 120;
  set((st) => ({
    tasks: st.tasks.map((x) => (x.id === t.id ? { ...x, status: 'reviewed' } : x)),
    fb: { ...st.fb, [t.id]: {
      teacher: 't1', date: 'اليوم', dur, scores: { hifz: 4, tajweed: 4, fluency: 3 }, decision: 'approve',
      notes: [{ t: Math.min(8, dur * 0.3), text: 'بداية موفقة، انتبه لإظهار الغنّة.' }, { t: Math.min(dur - 1, dur * 0.7), text: 'تردّد هنا، راجع هذا الموضع.' }],
      voice: 28, general: 'حفظ جيد ومستقر، والطلاقة تتحسن مع التكرار.', needs: 'الآيات 6–8', next: 'راجع الآيات 6–8 ثم انتقل للنطاق التالي.',
    } },
  }));
  toast(`وصل تقييم المعلم: ${t.title}`, 'bell');
}

/* ------------------------------------------------------------------ */
/* Assignment                                                           */
/* ------------------------------------------------------------------ */
export function openAssign(sid?: string) {
  set({ af: { sid: sid || (LIVE ? get().students[0]?.id ?? '' : 'u1'), type: 'hifz', s: '67', from: '', to: '', due: 'tomorrow', time: '21:00', instr: '', needRec: true, errors: {} } });
  go('tassign');
}
export function sendAssign() {
  const f = get().af!; const e: Record<string, string> = {}; const max = SUR[+f.s][1];
  const a = parseInt(f.from, 10), b = parseInt(f.to, 10);
  if (!a || a < 1) e.from = 'أدخل رقم آية البداية'; else if (a > max) e.from = `السورة تحتوي ${max} آية فقط`;
  if (!b || b < 1) e.to = 'أدخل رقم آية النهاية'; else if (b > max) e.to = `السورة تحتوي ${max} آية فقط`; else if (a && b < a) e.to = 'يجب أن تكون النهاية بعد البداية';
  if (Object.keys(e).length) { up('af', { errors: e }); return; }
  if (LIVE) { if (f.sid) live.createAssignment(f); else toast('لا يوجد طلاب مرتبطون بك بعد', 'alert'); return; }
  const stu = STUDENTS.find((x) => x.id === f.sid)!;
  const due = { today: 'اليوم، 9:00 م', tomorrow: 'غدًا، 9:00 م', in3: 'الأربعاء 14 أكتوبر', week: 'الأحد 18 أكتوبر' }[f.due];
  const name = SUR[+f.s][0];
  // Only the demo student (u1) has a live plan; others are summary-only demo rows.
  if (f.sid === 'u1') {
    const task: Task = {
      id: 'k' + Date.now(), type: f.type, title: f.type === 'tajweed' ? 'تجويد: سورة ' + name : `${typeL(f.type)} سورة ${name}`,
      s: +f.s, from: a, to: b, due, status: 'not_started', instr: f.instr.trim() || 'لا توجد توجيهات إضافية.', isNew: true,
    };
    set((s) => ({ tasks: [task, ...s.tasks] }));
  }
  back();
  toast(`أُرسل الواجب إلى ${stu.name}`);
}

/* ------------------------------------------------------------------ */
/* Quiz                                                                 */
/* ------------------------------------------------------------------ */
export function startQuiz(id: string) {
  set({ quiz: { id, phase: 'intro', idx: 0, ans: {}, rec: false, submitted: false } });
  go('quiz');
}
export const quizUnanswered = (q: NonNullable<AppState['quiz']>) =>
  QUIZ.filter((x, i) => (x.rec ? !q.rec : q.ans[i] === undefined)).length;
