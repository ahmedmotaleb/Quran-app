/** Demo data for the admin portal (بيانات عرض). Replace with paginated API calls. */
import { TEACHERS } from '@/data/demo';

export type Status = 'active' | 'pending' | 'expired' | 'off';
export type UserRole = 'طالب' | 'طالبة' | 'ولي أمر';

export interface AdminUser { id: number; name: string; role: UserRole; email: string; teacher: string | null; parent: string | null; children: string[]; st: Status }
export interface AdminTeacher { id: number; name: string; spec: string; n: string; st: Status }
export interface AdminContent { id: number; name: string; by: string; k: string; st: Status }
export interface AdminSub { id: number; name: string; plan: string; due: string; st: Status }

export const ADMIN_EMAIL = 'admin@halqa.app';

export const STATUS: Record<Status, { label: string; bg: string; fg: string }> = {
  active: { label: 'نشط', bg: '#D8E5D7', fg: '#124C46' },
  pending: { label: 'بانتظار المراجعة', bg: '#F3E6CC', fg: '#6B470C' },
  expired: { label: 'منتهي', bg: '#F5E1DC', fg: '#8E2F20' },
  off: { label: 'موقوف', bg: '#ECE7DB', fg: '#45534E' },
};

export const TEACHER_NAMES = TEACHERS.map((t) => t.name);

const SEED: AdminUser[] = [
  { id: 1, name: 'يوسف أحمد', role: 'طالب', email: 'yousef@halqa.app', teacher: 'الشيخ عبدالرحمن السالم', parent: 'أحمد العلي', children: [], st: 'active' },
  { id: 2, name: 'سارة أحمد', role: 'طالبة', email: 'sara@halqa.app', teacher: 'الأستاذة مريم القحطاني', parent: 'أحمد العلي', children: [], st: 'active' },
  { id: 3, name: 'أحمد العلي', role: 'ولي أمر', email: 'parent@halqa.app', teacher: null, parent: null, children: ['يوسف أحمد', 'سارة أحمد'], st: 'active' },
  { id: 4, name: 'عمر الحربي', role: 'طالب', email: 'omar@halqa.app', teacher: 'الشيخ عبدالرحمن السالم', parent: null, children: [], st: 'active' },
  { id: 5, name: 'منى الشهري', role: 'طالبة', email: 'mona@halqa.app', teacher: null, parent: null, children: [], st: 'pending' },
  { id: 6, name: 'سلمان القرشي', role: 'ولي أمر', email: 'salman@halqa.app', teacher: null, parent: null, children: [], st: 'pending' },
];

const M = ['محمد', 'عبدالله', 'خالد', 'فهد', 'إبراهيم', 'حمزة', 'زياد', 'بدر', 'سعد', 'تركي', 'أنس', 'مالك'];
const F = ['نورة', 'لمى', 'هيا', 'ريم', 'جود', 'رهف', 'دانة', 'شهد', 'لين', 'أسماء', 'مريم', 'غلا'];
const L = ['العتيبي', 'القحطاني', 'الغامدي', 'الزهراني', 'الشمري', 'الدوسري', 'المطيري', 'الحربي', 'السبيعي', 'العنزي', 'البقمي', 'الجهني', 'المالكي'];

/** Deterministic roster so lists exercise search, filters and pagination at realistic size. */
function generate(): AdminUser[] {
  const out: AdminUser[] = [];
  for (let i = 0; i < 180; i++) {
    const female = i % 3 === 1;
    const name = `${(female ? F : M)[(i * 7) % 12]} ${L[(i * 5 + 3) % 13]}`;
    const pending = i % 23 === 4;
    out.push({
      id: 100 + i, name, role: female ? 'طالبة' : 'طالب', email: `student${100 + i}@halqa.app`,
      teacher: pending ? null : TEACHER_NAMES[i % TEACHER_NAMES.length], parent: null, children: [],
      st: pending ? 'pending' : i % 31 === 7 ? 'off' : 'active',
    });
  }
  return out;
}
export const initialUsers = () => [...SEED, ...generate()];

export const initialTeachers = (): AdminTeacher[] => [
  { id: 1, name: 'الشيخ عبدالرحمن السالم', spec: 'حفظ وتجويد', n: '8 طلاب', st: 'active' },
  { id: 2, name: 'الأستاذة مريم القحطاني', spec: 'تحفيظ الأطفال', n: '5 طلاب', st: 'active' },
  { id: 3, name: 'الشيخ خالد العمري', spec: 'تجويد متقدم', n: '4 طلاب', st: 'active' },
  { id: 4, name: 'الأستاذ ماجد الغامدي', spec: 'قراءات', n: '—', st: 'pending' },
];
export const initialContent = (): AdminContent[] => [
  { id: 1, name: 'مقدمة في أحكام النون الساكنة', by: 'الشيخ عبدالرحمن السالم', k: 'محاضرة فيديو', st: 'pending' },
  { id: 2, name: 'اختبار المدود', by: 'الشيخ خالد العمري', k: 'اختبار', st: 'pending' },
  { id: 3, name: 'آداب حامل القرآن', by: 'الأستاذة هدى الزهراني', k: 'محاضرة صوتية', st: 'active' },
  { id: 4, name: 'نزول القرآن وجمعه', by: 'الشيخ خالد العمري', k: 'محاضرة فيديو', st: 'active' },
];
export const initialSubs = (): AdminSub[] => [
  { id: 1, name: 'أحمد العلي', plan: 'باقة الأسرة · طالبان', due: '1 نوفمبر 2026', st: 'active' },
  { id: 2, name: 'عمر الحربي', plan: 'فردية · 8 جلسات شهريًا', due: '15 أكتوبر 2026', st: 'active' },
  { id: 3, name: 'منى الشهري', plan: 'فردية · 4 جلسات', due: '—', st: 'pending' },
  { id: 4, name: 'فيصل الدوسري', plan: 'فردية · 8 جلسات', due: 'منتهية 2 أكتوبر', st: 'expired' },
];
