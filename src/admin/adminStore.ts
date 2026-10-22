import { create } from 'zustand';
import {
  ADMIN_EMAIL, initialBookings, initialCircles, initialContent, initialSettings, initialSubs, initialTeachers, initialUsers,
  type AdminCircle, type AdminContent, type AdminSettings, type AdminUser, type Status, type UserRole,
} from './adminData';
import { DEMO_PASSWORD } from '@/data/demo';
import { LIVE, ApiError, resetCsrf } from '@/api/client';
import * as E from '@/api/endpoints';

/** Sidebar sections, in the order the brief lists them. */
export type Section = 'overview' | 'students' | 'teachers' | 'parents' | 'circles' | 'bookings' | 'lectures' | 'quizzes' | 'subs' | 'settings';
export type Dialog =
  | { kind: 'link'; id: number; approve: boolean }
  | { kind: 'user'; id: number | null; role: UserRole }
  | { kind: 'circle'; id: number | null }
  | { kind: 'content'; id: number | null; ckind: 'lecture' | 'quiz' }
  | { kind: 'student'; id: number }
  | { kind: 'teacher'; id: number }
  | { kind: 'confirm'; title: string; body: string; ok: string; onOk: () => void }
  | null;

const SECTIONS: Section[] = ['overview', 'students', 'teachers', 'parents', 'circles', 'bookings', 'lectures', 'quizzes', 'subs', 'settings'];
/** `#/admin/<section>?…` → the section (list filters after `?` belong to that section's screen). */
export function sectionFromHash(): Section | null {
  const m = window.location.hash.match(/^#\/admin\/([a-z]+)/);
  return m && SECTIONS.includes(m[1] as Section) ? (m[1] as Section) : null;
}

const initial = () => ({
  authed: false,
  /** Live mode: the signed-in admin as the server reports it; `restoring` while the session is checked. */
  me: null as E.Me | null,
  restoring: LIVE,
  login: { email: '', pw: '', otp: '', needOtp: false, trust: true, errors: {} as Record<string, string | null>, loading: false },
  sec: (sectionFromHash() ?? 'overview') as Section,
  q: '', f: 'all' as 'all' | Status, extra: 'all', page: 1,
  toast: null as string | null,
  dialog: null as Dialog,
  users: initialUsers(),
  teachers: initialTeachers(),
  content: initialContent(),
  subs: initialSubs(),
  circles: initialCircles(),
  bookings: initialBookings(),
  settings: initialSettings(),
});
export type AdminState = ReturnType<typeof initial>;
export const useAdmin = create<AdminState>(() => initial());
const set = useAdmin.setState; const get = useAdmin.getState;
export const setAdmin = set;
export const closeDialog = () => set({ dialog: null });

export const PAGE_SIZE = 10;

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(m: string) {
  clearTimeout(toastTimer); set({ toast: m });
  toastTimer = setTimeout(() => set({ toast: null }), 2600);
}

export function goSection(sec: Section, fromHistory = false) {
  set({ sec, q: '', f: 'all', extra: 'all', page: 1, dialog: null });
  // The section lives in the URL so refresh and back/forward return to it (filters follow after `?`).
  if (!fromHistory && window.location.hash.split('?')[0] !== `#/admin/${sec}`) window.history.pushState(null, '', `#/admin/${sec}`);
  window.scrollTo({ top: 0 });
}

export type ListKey = 'users' | 'teachers' | 'content' | 'subs' | 'circles' | 'bookings';
export function setStatus(list: ListKey, id: number, st: Status, msg: string) {
  set((s) => ({ [list]: (s[list] as { id: number; st: Status }[]).map((x) => (x.id === id ? { ...x, st } : x)), dialog: null }) as Partial<AdminState>);
  toast(msg);
}
export const confirmAction = (title: string, body: string, ok: string, onOk: () => void) => set({ dialog: { kind: 'confirm', title, body, ok, onOk } });

const NET = 'تعذّر الاتصال بالخادم. تحقق من الإنترنت وحاول مرة أخرى.';

/** Live mode: restore an existing server session (admins only) after a refresh. */
export async function adminRestore() {
  if (!LIVE) return;
  try {
    const u = await E.me();
    if (u.role === 'admin') set({ authed: true, me: u, restoring: false });
    else set({ restoring: false, login: { ...get().login, errors: { email: 'أنت مسجّل الدخول بحساب ليس للإدارة. سجّل الدخول بحساب الإدارة للمتابعة.' } } });
  } catch {
    set({ restoring: false }); // 401/403: no session — show the sign-in form
  }
}

/** Live mode: real admin sign-in (POST admin/auth/login), with the two-step code when the account has it on. */
async function adminLoginLive() {
  const L = get().login; const e: Record<string, string> = {}; const em = L.email.trim().toLowerCase();
  if (!em) e.email = 'أدخل البريد الإلكتروني'; else if (!/^\S+@\S+\.\S+$/.test(em)) e.email = 'صيغة البريد الإلكتروني غير صحيحة';
  if (!L.pw) e.pw = 'أدخل كلمة المرور';
  if (L.needOtp && !/^\d{6}$/.test(L.otp.trim())) e.otp = 'أدخل الرمز المكوّن من 6 أرقام';
  if (Object.keys(e).length) { set({ login: { ...L, errors: e } }); return; }
  set({ login: { ...L, errors: {}, loading: true } });
  try {
    const r = await E.adminLogin(em, L.pw, L.otp.trim(), L.needOtp && L.trust);
    resetCsrf(); // Django rotates the CSRF token on sign-in
    set({ authed: true, me: r.user, login: initial().login });
  } catch (err) {
    const x = err as ApiError; const cur = get().login;
    if (x.code === 'mfa_required') { set({ login: { ...cur, loading: false, needOtp: true, errors: {} } }); return; }
    const where = x.code === 'mfa_invalid' ? 'otp' : x.code === 'bad_credentials' ? 'pw'
      : ['not_admin', 'account_suspended', 'account_pending'].includes(x.code) ? 'email' : null;
    const m = x.status === 0 || x.code === 'network' ? NET : x.status === 429 ? 'محاولات كثيرة. انتظر دقيقة ثم حاول مرة أخرى.' : x.message;
    set({ login: { ...cur, loading: false, otp: where === 'otp' ? '' : cur.otp, errors: where ? { [where]: m } : { form: m } } });
  }
}

/** Separate admin sign-in: the real backend in live mode, a local simulation in demo mode. */
export function adminLogin() {
  if (LIVE) { void adminLoginLive(); return; }
  const L = get().login; const e: Record<string, string> = {}; const em = L.email.trim().toLowerCase();
  if (!em) e.email = 'أدخل البريد الإلكتروني'; else if (!/^\S+@\S+\.\S+$/.test(em)) e.email = 'صيغة البريد الإلكتروني غير صحيحة';
  else if (em !== ADMIN_EMAIL) e.email = 'هذا الحساب لا يملك صلاحيات الإدارة.';
  if (!L.pw) e.pw = 'أدخل كلمة المرور'; else if (!e.email && L.pw !== DEMO_PASSWORD) e.pw = 'كلمة المرور غير صحيحة';
  if (Object.keys(e).length) { set({ login: { ...L, errors: e } }); return; }
  set({ login: { ...L, errors: {}, loading: true } });
  setTimeout(() => set({ authed: true, login: initial().login }), 600);
}
export async function adminLogout() {
  if (LIVE) { try { await E.logout(); } catch { /* already signed out */ } resetCsrf(); }
  set({ ...initial(), restoring: false }); // clears every piece of admin data held in memory
}

/** Two-step verification setup for the signed-in admin (live mode). */
export const mfaStart = () => E.mfaSetup();
export async function mfaFinish(otp: string) {
  await E.mfaConfirm(otp);
  const me = get().me; if (me) set({ me: { ...me, mfa_enabled: true } });
}

export function saveLink(id: number, teacher: string | null, parent: string | null, children: string[], approve: boolean) {
  const u = get().users.find((x) => x.id === id)!;
  set((s) => ({
    users: s.users.map((x) => {
      if (x.id === id) return { ...x, teacher, parent, children, st: approve ? 'active' : x.st };
      // Keep both sides of a parent ↔ child link in sync.
      if (u.role === 'ولي أمر' && x.role !== 'ولي أمر') {
        if (children.includes(x.name)) return { ...x, parent: u.name };
        if (x.parent === u.name) return { ...x, parent: null };
      }
      if (u.role !== 'ولي أمر' && x.role === 'ولي أمر') {
        const has = x.children.includes(u.name);
        if (x.name === parent && !has) return { ...x, children: [...x.children, u.name] };
        if (x.name !== parent && has) return { ...x, children: x.children.filter((c) => c !== u.name) };
      }
      return x;
    }),
    dialog: null,
  }));
  toast(approve ? `تم اعتماد ${u.name} وربط الحساب` : `تم تحديث ربط ${u.name}`);
}

export function saveUser(id: number | null, data: Pick<AdminUser, 'name' | 'role' | 'email'> & { level?: string }) {
  if (id === null) {
    const nu: AdminUser = { id: Date.now(), ...data, teacher: null, parent: null, children: [], st: 'active', joined: 'أكتوبر 2026' };
    set((s) => ({ users: [nu, ...s.users], dialog: null, q: '', f: 'all', extra: 'all', page: 1 }));
    toast(`أُضيف ${data.name}. اربطه من «تعديل الربط».`);
  } else {
    set((s) => ({ users: s.users.map((x) => (x.id === id ? { ...x, ...data } : x)), dialog: null }));
    toast('حُفظت التعديلات');
  }
}

export function saveCircle(id: number | null, data: Omit<AdminCircle, 'id' | 'st'>) {
  const st: Status = data.members >= data.capacity ? 'full' : 'active';
  if (id === null) {
    set((s) => ({ circles: [{ id: Date.now(), ...data, st: 'draft' }, ...s.circles], dialog: null }));
    toast(`أُنشئت «${data.name}» كمسودة. انشرها لتظهر للطلاب.`);
  } else {
    set((s) => ({ circles: s.circles.map((x) => (x.id === id ? { ...x, ...data, st: x.st === 'draft' || x.st === 'off' ? x.st : st } : x)), dialog: null }));
    toast('حُفظت الحلقة');
  }
}

export function saveContent(id: number | null, data: Omit<AdminContent, 'id' | 'st'>) {
  if (id === null) {
    set((s) => ({ content: [{ id: Date.now(), ...data, st: 'draft' }, ...s.content], dialog: null }));
    toast('حُفظ كمسودة');
  } else {
    set((s) => ({ content: s.content.map((x) => (x.id === id ? { ...x, ...data } : x)), dialog: null }));
    toast('حُفظت التعديلات');
  }
}

export function saveSettings(v: AdminSettings) { set({ settings: v }); toast('حُفظت الإعدادات وطُبّقت على المنصة (تجريبي)'); }
