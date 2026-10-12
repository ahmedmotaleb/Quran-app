import { create } from 'zustand';
import {
  ADMIN_EMAIL, initialBookings, initialCircles, initialContent, initialSettings, initialSubs, initialTeachers, initialUsers,
  type AdminCircle, type AdminContent, type AdminSettings, type AdminUser, type Status, type UserRole,
} from './adminData';
import { DEMO_PASSWORD } from '@/data/demo';

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

const initial = () => ({
  authed: false,
  login: { email: '', pw: '', errors: {} as Record<string, string | null>, loading: false },
  sec: 'overview' as Section,
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

export function goSection(sec: Section) {
  set({ sec, q: '', f: 'all', extra: 'all', page: 1, dialog: null });
  window.scrollTo({ top: 0 });
}

export type ListKey = 'users' | 'teachers' | 'content' | 'subs' | 'circles' | 'bookings';
export function setStatus(list: ListKey, id: number, st: Status, msg: string) {
  set((s) => ({ [list]: (s[list] as { id: number; st: Status }[]).map((x) => (x.id === id ? { ...x, st } : x)), dialog: null }) as Partial<AdminState>);
  toast(msg);
}
export const confirmAction = (title: string, body: string, ok: string, onOk: () => void) => set({ dialog: { kind: 'confirm', title, body, ok, onOk } });

/** Simulated admin sign-in: separate from the app login, admin role only. */
export function adminLogin() {
  const L = get().login; const e: Record<string, string> = {}; const em = L.email.trim().toLowerCase();
  if (!em) e.email = 'أدخل البريد الإلكتروني'; else if (!/^\S+@\S+\.\S+$/.test(em)) e.email = 'صيغة البريد الإلكتروني غير صحيحة';
  else if (em !== ADMIN_EMAIL) e.email = 'هذا الحساب لا يملك صلاحيات الإدارة.';
  if (!L.pw) e.pw = 'أدخل كلمة المرور'; else if (!e.email && L.pw !== DEMO_PASSWORD) e.pw = 'كلمة المرور غير صحيحة';
  if (Object.keys(e).length) { set({ login: { ...L, errors: e } }); return; }
  set({ login: { ...L, errors: {}, loading: true } });
  setTimeout(() => set({ authed: true, login: { email: '', pw: '', errors: {}, loading: false } }), 600);
}
export function adminLogout() { set({ ...initial() }); }

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
