/** Demo data for the admin portal (بيانات عرض). Replace with paginated API calls. */
import { TEACHERS } from '@/data/demo';
import { BRAND } from '@/theme/brand';

export type Status = 'active' | 'pending' | 'expired' | 'off' | 'confirmed' | 'completed' | 'cancelled' | 'full' | 'draft';
export type UserRole = 'طالب' | 'طالبة' | 'ولي أمر';

export interface AdminUser {
  id: number; name: string; role: UserRole; email: string; teacher: string | null; parent: string | null; children: string[];
  st: Status; level?: string; age?: number; joined?: string;
}
export interface AdminTeacher { id: number; name: string; spec: string; email: string; types: string; st: Status }
export interface AdminContent { id: number; name: string; by: string; k: string; kind: 'lecture' | 'quiz'; topic: string; level: string; st: Status }
export interface AdminSub { id: number; name: string; plan: string; due: string; st: Status }
export interface AdminCircle { id: number; name: string; teacher: string; schedule: string; level: string; members: number; capacity: number; st: Status }
export interface AdminBooking { id: number; student: string; teacher: string; when: string; type: string; st: Status }
export interface AdminSettings {
  orgName: string; supportEmail: string; tz: string; cancelHours: number; joinMinutes: number;
  durIndividual: number; durGroup: number; reminders: boolean; parentReports: boolean; openSignup: boolean;
}

export const ADMIN_EMAIL = 'admin@halqa.app';

export const STATUS: Record<Status, { label: string; bg: string; fg: string }> = {
  active: { label: 'نشط', bg: '#D8E5D7', fg: '#124C46' },
  pending: { label: 'بانتظار المراجعة', bg: '#F3E6CC', fg: '#6B470C' },
  expired: { label: 'منتهي', bg: '#F5E1DC', fg: '#8E2F20' },
  off: { label: 'موقوف', bg: '#ECE7DB', fg: '#45534E' },
  confirmed: { label: 'مؤكدة', bg: '#D8E5D7', fg: '#124C46' },
  completed: { label: 'مكتملة', bg: '#ECE7DB', fg: '#45534E' },
  cancelled: { label: 'ملغاة', bg: '#F5E1DC', fg: '#8E2F20' },
  full: { label: 'مكتملة العدد', bg: '#124C46', fg: '#F7F3E8' },
  draft: { label: 'مسودة', bg: '#ECE7DB', fg: '#45534E' },
};

export const TEACHER_NAMES = TEACHERS.map((t) => t.name);
export const LEVELS = ['مبتدئ', 'متوسط', 'متقدم'];
export const TOPICS = ['التجويد', 'الحفظ والمراجعة', 'آداب التلاوة', 'علوم القرآن'];

const SEED: AdminUser[] = [
  { id: 1, name: 'يوسف أحمد', role: 'طالب', email: 'yousef@halqa.app', teacher: 'الشيخ عبدالرحمن السالم', parent: 'أحمد العلي', children: [], st: 'active', level: 'متوسط', age: 14, joined: 'مارس 2026' },
  { id: 2, name: 'سارة أحمد', role: 'طالبة', email: 'sara@halqa.app', teacher: 'الأستاذة مريم القحطاني', parent: 'أحمد العلي', children: [], st: 'active', level: 'مبتدئ', age: 10, joined: 'مارس 2026' },
  { id: 3, name: 'أحمد العلي', role: 'ولي أمر', email: 'parent@halqa.app', teacher: null, parent: null, children: ['يوسف أحمد', 'سارة أحمد'], st: 'active', joined: 'مارس 2026' },
  { id: 4, name: 'عمر الحربي', role: 'طالب', email: 'omar@halqa.app', teacher: 'الشيخ عبدالرحمن السالم', parent: null, children: [], st: 'active', level: 'متوسط', age: 16, joined: 'مايو 2026' },
  { id: 5, name: 'منى الشهري', role: 'طالبة', email: 'mona@halqa.app', teacher: null, parent: null, children: [], st: 'pending', level: 'مبتدئ', age: 12, joined: 'أكتوبر 2026' },
  { id: 6, name: 'سلمان القرشي', role: 'ولي أمر', email: 'salman@halqa.app', teacher: null, parent: null, children: [], st: 'pending', joined: 'أكتوبر 2026' },
  { id: 7, name: 'هالة الدوسري', role: 'ولي أمر', email: 'hala@halqa.app', teacher: null, parent: null, children: [], st: 'active', joined: 'أغسطس 2026' },
];

const M = ['محمد', 'عبدالله', 'خالد', 'فهد', 'إبراهيم', 'حمزة', 'زياد', 'بدر', 'سعد', 'تركي', 'أنس', 'مالك'];
const F = ['نورة', 'لمى', 'هيا', 'ريم', 'جود', 'رهف', 'دانة', 'شهد', 'لين', 'أسماء', 'مريم', 'غلا'];
const L = ['العتيبي', 'القحطاني', 'الغامدي', 'الزهراني', 'الشمري', 'الدوسري', 'المطيري', 'الحربي', 'السبيعي', 'العنزي', 'البقمي', 'الجهني', 'المالكي'];
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر'];

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
      level: LEVELS[i % 3], age: 8 + (i % 14), joined: `${MONTHS[i % 9]} 2026`,
    });
  }
  return out;
}
export const initialUsers = () => [...SEED, ...generate()];

export const initialTeachers = (): AdminTeacher[] => [
  { id: 1, name: 'الشيخ عبدالرحمن السالم', spec: 'حفظ وتجويد', email: 'teacher@halqa.app', types: 'فردية · جماعية', st: 'active' },
  { id: 2, name: 'الأستاذة مريم القحطاني', spec: 'تحفيظ الأطفال', email: 'maryam@halqa.app', types: 'فردية', st: 'active' },
  { id: 3, name: 'الشيخ خالد العمري', spec: 'تجويد متقدم', email: 'khalid@halqa.app', types: 'فردية · جماعية', st: 'active' },
  { id: 5, name: 'الأستاذة هدى الزهراني', spec: 'مراجعة وتثبيت', email: 'huda@halqa.app', types: 'جماعية', st: 'active' },
  { id: 4, name: 'الأستاذ ماجد الغامدي', spec: 'قراءات', email: 'majed@halqa.app', types: 'فردية', st: 'pending' },
];

export const initialContent = (): AdminContent[] => [
  { id: 1, name: 'مقدمة في أحكام النون الساكنة', by: 'الشيخ عبدالرحمن السالم', k: 'محاضرة فيديو', kind: 'lecture', topic: 'التجويد', level: 'مبتدئ', st: 'pending' },
  { id: 3, name: 'آداب حامل القرآن', by: 'الأستاذة هدى الزهراني', k: 'محاضرة صوتية', kind: 'lecture', topic: 'آداب التلاوة', level: 'جميع المستويات', st: 'active' },
  { id: 4, name: 'نزول القرآن وجمعه', by: 'الشيخ خالد العمري', k: 'محاضرة فيديو', kind: 'lecture', topic: 'علوم القرآن', level: 'متوسط', st: 'active' },
  { id: 5, name: 'الإظهار الحلقي: أمثلة تطبيقية', by: 'الشيخ عبدالرحمن السالم', k: 'محاضرة فيديو', kind: 'lecture', topic: 'التجويد', level: 'مبتدئ', st: 'active' },
  { id: 6, name: 'المدود وأنواعها', by: 'الشيخ خالد العمري', k: 'محاضرة فيديو', kind: 'lecture', topic: 'التجويد', level: 'متوسط', st: 'active' },
  { id: 7, name: 'كيف تراجع حفظك بانتظام', by: 'الأستاذة هدى الزهراني', k: 'محاضرة صوتية', kind: 'lecture', topic: 'الحفظ والمراجعة', level: 'جميع المستويات', st: 'active' },
  { id: 2, name: 'اختبار المدود', by: 'الشيخ خالد العمري', k: 'اختبار · 10 أسئلة', kind: 'quiz', topic: 'التجويد', level: 'متوسط', st: 'pending' },
  { id: 8, name: 'اختبار أحكام النون الساكنة والتنوين', by: 'الشيخ عبدالرحمن السالم', k: 'اختبار · 5 أسئلة · تلاوة', kind: 'quiz', topic: 'التجويد', level: 'مبتدئ', st: 'active' },
  { id: 9, name: 'اختبار تلاوة: سورة النبأ 1–16', by: 'الشيخ عبدالرحمن السالم', k: 'اختبار · سؤال تلاوة', kind: 'quiz', topic: 'الحفظ والمراجعة', level: 'متوسط', st: 'active' },
  { id: 10, name: 'اختبار مخارج الحروف', by: 'الشيخ خالد العمري', k: 'اختبار · 8 أسئلة', kind: 'quiz', topic: 'التجويد', level: 'متقدم', st: 'off' },
];

export const initialSubs = (): AdminSub[] => [
  { id: 1, name: 'أحمد العلي', plan: 'باقة الأسرة · طالبان', due: '1 نوفمبر 2026', st: 'active' },
  { id: 2, name: 'عمر الحربي', plan: 'فردية · 8 جلسات شهريًا', due: '15 أكتوبر 2026', st: 'active' },
  { id: 3, name: 'منى الشهري', plan: 'فردية · 4 جلسات', due: '—', st: 'pending' },
  { id: 4, name: 'فيصل الدوسري', plan: 'فردية · 8 جلسات', due: 'منتهية 2 أكتوبر', st: 'expired' },
  { id: 5, name: 'هالة الدوسري', plan: 'باقة الأسرة · 3 أبناء', due: '20 نوفمبر 2026', st: 'active' },
];

export const initialCircles = (): AdminCircle[] => [
  { id: 1, name: 'حلقة المراجعة المسائية', teacher: 'الشيخ عبدالرحمن السالم', schedule: 'الأحد والثلاثاء · 8:00 م', level: 'متوسط', members: 6, capacity: 8, st: 'active' },
  { id: 2, name: 'حلقة جزء عمّ للأطفال', teacher: 'الأستاذة مريم القحطاني', schedule: 'السبت والإثنين · 4:00 م', level: 'مبتدئ', members: 10, capacity: 10, st: 'full' },
  { id: 3, name: 'تثبيت جزء تبارك', teacher: 'الأستاذة هدى الزهراني', schedule: 'الأربعاء · 7:00 م', level: 'متوسط', members: 9, capacity: 12, st: 'active' },
  { id: 4, name: 'تطبيقات التجويد المتقدم', teacher: 'الشيخ خالد العمري', schedule: 'الخميس · 9:00 م', level: 'متقدم', members: 4, capacity: 8, st: 'active' },
  { id: 5, name: 'حلقة الفجر', teacher: 'الشيخ عبدالرحمن السالم', schedule: 'يوميًا · 5:30 ص', level: 'جميع المستويات', members: 0, capacity: 15, st: 'draft' },
];

/** Bookings across the platform; times shown in Riyadh time (GMT+3). */
export function initialBookings(): AdminBooking[] {
  const days = ['الأحد 11 أكتوبر', 'الإثنين 12 أكتوبر', 'الثلاثاء 13 أكتوبر', 'الأربعاء 14 أكتوبر', 'الخميس 15 أكتوبر', 'السبت 10 أكتوبر', 'الخميس 8 أكتوبر'];
  const hours = ['4:00 م', '5:00 م', '6:30 م', '8:00 م', '9:00 م'];
  const fixed: AdminBooking[] = [
    { id: 1, student: 'يوسف أحمد', teacher: 'الشيخ عبدالرحمن السالم', when: 'الأحد 11 أكتوبر · 5:00 م', type: 'فردية · 45 دقيقة', st: 'confirmed' },
    { id: 2, student: 'يوسف أحمد', teacher: 'الشيخ خالد العمري', when: 'الثلاثاء 13 أكتوبر · 6:30 م', type: 'فردية · 45 دقيقة', st: 'confirmed' },
    { id: 3, student: 'يوسف أحمد', teacher: 'الشيخ عبدالرحمن السالم', when: 'الخميس 8 أكتوبر · 5:00 م', type: 'فردية · 45 دقيقة', st: 'completed' },
  ];
  const out = [...fixed];
  for (let i = 0; i < 42; i++) {
    const d = (i * 3) % days.length; const past = d >= 5;
    out.push({
      id: 10 + i, student: `${(i % 2 ? F : M)[(i * 5) % 12]} ${L[(i * 7 + 1) % 13]}`, teacher: TEACHER_NAMES[i % TEACHER_NAMES.length],
      when: `${days[d]} · ${hours[i % 5]}`, type: i % 4 === 0 ? 'جماعية · 60 دقيقة' : 'فردية · 45 دقيقة',
      st: past ? (i % 7 === 2 ? 'cancelled' : 'completed') : i % 9 === 4 ? 'cancelled' : 'confirmed',
    });
  }
  return out;
}

export const initialSettings = (): AdminSettings => ({
  orgName: `${BRAND.ar} لتعليم القرآن`, supportEmail: 'support@halqa.app', tz: 'riyadh', cancelHours: 12, joinMinutes: 10,
  durIndividual: 45, durGroup: 60, reminders: true, parentReports: true, openSignup: true,
});
