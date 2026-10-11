import { create } from 'zustand';
import {
  ADMIN_EMAIL, initialContent, initialSubs, initialTeachers, initialUsers,
  type AdminUser, type Status,
} from './adminData';
import { DEMO_PASSWORD } from '@/data/demo';

export type Section = 'overview' | 'users' | 'teachers' | 'content' | 'subs';
export type Dialog =
  | { kind: 'link'; id: number; approve: boolean }
  | { kind: 'user'; id: number | null }
  | null;

const initial = () => ({
  authed: false,
  login: { email: '', pw: '', errors: {} as Record<string, string | null>, loading: false },
  sec: 'overview' as Section,
  q: '', f: 'all' as 'all' | Status, role: 'all', page: 1,
  toast: null as string | null,
  dialog: null as Dialog,
  users: initialUsers(),
  teachers: initialTeachers(),
  content: initialContent(),
  subs: initialSubs(),
});
export type AdminState = ReturnType<typeof initial>;
export const useAdmin = create<AdminState>(() => initial());
const set = useAdmin.setState; const get = useAdmin.getState;
export const setAdmin = set;

export const PAGE_SIZE = 10;

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(m: string) {
  clearTimeout(toastTimer); set({ toast: m });
  toastTimer = setTimeout(() => set({ toast: null }), 2600);
}

export function goSection(sec: Section) { set({ sec, q: '', f: 'all', role: 'all', page: 1, dialog: null }); }

type ListKey = 'users' | 'teachers' | 'content' | 'subs';
export function setStatus(list: ListKey, id: number, st: Status, msg: string) {
  set((s) => ({ [list]: (s[list] as { id: number; st: Status }[]).map((x) => (x.id === id ? { ...x, st } : x)) }) as Partial<AdminState>);
  toast(msg);
}

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
        const linked = children.includes(x.name);
        if (linked) return { ...x, parent: u.name };
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

export function saveUser(id: number | null, data: Pick<AdminUser, 'name' | 'role' | 'email'>) {
  if (id === null) {
    const nu: AdminUser = { id: Date.now(), ...data, teacher: null, parent: null, children: [], st: 'active' };
    set((s) => ({ users: [nu, ...s.users], dialog: null, q: '', f: 'all', role: 'all', page: 1 }));
    toast(`أُضيف ${data.name}. اربطه بمعلم أو أبناء من «تعديل الربط».`);
  } else {
    set((s) => ({ users: s.users.map((x) => (x.id === id ? { ...x, ...data } : x)), dialog: null }));
    toast('حُفظت التعديلات');
  }
}
