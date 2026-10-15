/**
 * Demo data (بيانات عرض). Everything here is simulated and lives only in memory.
 * Replace with API calls when a backend (FastAPI/Django + PostgreSQL) is connected.
 */
import type {
  Availability, Feedback, Lesson, OtherSubmission, QuizQuestion, Recording, Role, Session, Student, Task, Teacher, TimeZone,
} from './types';

/** The demo week. Index 0 is "today" (Sunday 11 October 2026). */
export const DAYS: [string, number][] = [
  ['الأحد', 11], ['الإثنين', 12], ['الثلاثاء', 13], ['الأربعاء', 14], ['الخميس', 15], ['الجمعة', 16], ['السبت', 17],
];
export const TODAY_LABEL = 'الأحد 11 أكتوبر 2026';

export const TZS: TimeZone[] = [
  { id: 'cairo', label: 'القاهرة', iana: 'Africa/Cairo' },
  { id: 'riyadh', label: 'الرياض', iana: 'Asia/Riyadh' },
  { id: 'dubai', label: 'دبي', iana: 'Asia/Dubai' },
  { id: 'kl', label: 'كوالالمبور', iana: 'Asia/Kuala_Lumpur' },
  { id: 'london', label: 'لندن', iana: 'Europe/London' },
];

/** Offline surah index used for assignments and as a fallback list: number → [name, ayah count]. */
export const SUR: Record<number, [string, number]> = {
  1: ['الفاتحة', 7], 67: ['الملك', 30], 68: ['القلم', 52], 78: ['النبأ', 40], 79: ['النازعات', 46],
  80: ['عبس', 42], 85: ['البروج', 22], 86: ['الطارق', 17], 87: ['الأعلى', 19], 89: ['الفجر', 30],
};

export const DEMO_PASSWORD = 'halqa123';
export const ACCOUNTS: Record<string, Role> = {
  'yousef@halqa.app': 'student', 'teacher@halqa.app': 'teacher', 'parent@halqa.app': 'parent', 'admin@halqa.app': 'admin',
};

export const TEACHERS: Teacher[] = [
  { id: 't1', name: 'الشيخ عبدالرحمن السالم', ini: 'ع', spec: 'حفظ وتجويد', tags: ['hifz', 'tajweed', 'group'], types: ['فردية', 'جماعية'], levels: 'جميع المستويات', aud: 'الرجال والأطفال', bio: 'مُجاز برواية حفص عن عاصم، يدرّس الحفظ والمراجعة منذ 12 عامًا، ويعتمد خططًا قصيرة منتظمة لتثبيت الحفظ.' },
  { id: 't2', name: 'الأستاذة مريم القحطاني', ini: 'م', spec: 'تحفيظ الأطفال', tags: ['hifz', 'kids'], types: ['فردية'], levels: 'مبتدئ', aud: 'النساء والأطفال', bio: 'متخصصة في تحفيظ الأطفال من 6 إلى 12 عامًا بأسلوب هادئ ومتدرّج، مع متابعة أسبوعية لولي الأمر.' },
  { id: 't3', name: 'الشيخ خالد العمري', ini: 'خ', spec: 'تجويد متقدم', tags: ['tajweed'], types: ['فردية', 'جماعية'], levels: 'متوسط ومتقدم', aud: 'الرجال', bio: 'يركّز على إتقان مخارج الحروف وصفاتها وتطبيق الأحكام أثناء التلاوة، مع تمارين قصيرة بعد كل جلسة.' },
  { id: 't4', name: 'الأستاذة هدى الزهراني', ini: 'هـ', spec: 'مراجعة وتثبيت', tags: ['review', 'group'], types: ['جماعية'], levels: 'متوسط', aud: 'النساء', bio: 'تدير حلقات مراجعة جماعية لتثبيت الأجزاء المحفوظة وربط الآيات المتشابهة.' },
];

export const STUDENTS: Student[] = [
  { id: 'u1', name: 'يوسف أحمد', ini: 'ي', age: 14, level: 'متوسط', plan: 'حفظ سورة الملك', att: '11 من 12' },
  { id: 'u2', name: 'سارة أحمد', ini: 'س', age: 10, level: 'مبتدئ', plan: 'حفظ سورة الطارق', att: '8 من 8' },
  { id: 'u3', name: 'عمر الحربي', ini: 'ع', age: 16, level: 'متوسط', plan: 'حفظ سورة الفجر', att: '9 من 10' },
  { id: 'u4', name: 'ليان الشمري', ini: 'ل', age: 12, level: 'مبتدئ', plan: 'تجويد الميم الساكنة', att: '10 من 10' },
  { id: 'u5', name: 'عبدالله المطيري', ini: 'ع', age: 19, level: 'متقدم', plan: 'مراجعة جزء تبارك', att: '6 من 9', late: true },
  { id: 'u6', name: 'ريم العتيبي', ini: 'ر', age: 11, level: 'مبتدئ', plan: 'حفظ سورة الأعلى', att: '7 من 8' },
  { id: 'u7', name: 'فيصل الدوسري', ini: 'ف', age: 15, level: 'متوسط', plan: 'حفظ سورة البروج', att: '5 من 8', late: true },
  { id: 'u8', name: 'نورة السبيعي', ini: 'ن', age: 13, level: 'متوسط', plan: 'مراجعة جزء عمّ', att: '12 من 12' },
];

export const LESSONS: Lesson[] = [
  { id: 'l1', title: 'مقدمة في أحكام النون الساكنة والتنوين', topic: 'tajweed', topicL: 'التجويد', level: 'مبتدئ', media: 'video', dur: '14 دقيقة' },
  { id: 'l2', title: 'الإظهار الحلقي: أمثلة تطبيقية', topic: 'tajweed', topicL: 'التجويد', level: 'مبتدئ', media: 'video', dur: '11 دقيقة' },
  { id: 'l3', title: 'آداب حامل القرآن', topic: 'adab', topicL: 'آداب التلاوة', level: 'جميع المستويات', media: 'audio', dur: '18 دقيقة' },
  { id: 'l4', title: 'المدود وأنواعها', topic: 'tajweed', topicL: 'التجويد', level: 'متوسط', media: 'video', dur: '22 دقيقة' },
  { id: 'l5', title: 'كيف تراجع حفظك بانتظام', topic: 'hifz', topicL: 'الحفظ والمراجعة', level: 'جميع المستويات', media: 'audio', dur: '16 دقيقة' },
  { id: 'l6', title: 'نزول القرآن وجمعه', topic: 'ulum', topicL: 'علوم القرآن', level: 'متوسط', media: 'video', dur: '25 دقيقة' },
];

export const QUIZ: QuizQuestion[] = [
  { q: 'كم عدد حروف الإظهار الحلقي؟', o: ['4', '6', '15', '1'], a: 1 },
  { q: 'ما الحكم عند مجيء الباء بعد النون الساكنة أو التنوين؟', o: ['الإخفاء', 'الإدغام', 'الإقلاب', 'الإظهار'], a: 2 },
  { q: 'كم عدد حروف الإخفاء الحقيقي؟', o: ['15', '6', '4', '10'], a: 0 },
  { q: 'حروف الإدغام مجموعة في كلمة:', o: ['يرملون', 'ينمو', 'قطب جد', 'أخي هاك'], a: 0 },
  { q: 'سجّل تلاوتك لموضع من سورة الملك يجتمع فيه حكما الإظهار والإخفاء.', rec: true },
];

export const SCREEN_NAMES = {
  splash: 'شاشة البداية', intro: 'التعريف', login: 'تسجيل الدخول', signup: 'إنشاء حساب', forgot: 'استعادة كلمة المرور', onboard: 'إعداد الطالب',
  home: 'الرئيسية', plan: 'تعلمي', task: 'تفاصيل المهمة', record: 'تسجيل التلاوة', feedback: 'تقييم المعلم', mushaf: 'المصحف',
  circles: 'الجلسات', teacher: 'صفحة المعلم', bkreview: 'مراجعة الحجز', bkdone: 'تأكيد الحجز', session: 'تفاصيل الجلسة',
  live: 'الجلسة المباشرة', lesson: 'صفحة الدرس', quiz: 'الاختبار', progress: 'تقدمي', account: 'حسابي',
  tdash: 'لوحة اليوم (معلم)', tstudents: 'الطلاب (معلم)', tstudent: 'ملف الطالب', tassign: 'إنشاء واجب',
  treviews: 'المراجعات (معلم)', treview: 'مراجعة تسجيل', tschedule: 'المواعيد (معلم)', tcontent: 'إنشاء محتوى', phome: 'متابعة ولي الأمر', inbox: 'الإشعارات',
} as const;
export type Screen = keyof typeof SCREEN_NAMES;

export const initialTasks = (): Task[] => [
  { id: 'k1', type: 'hifz', title: 'حفظ سورة الملك', s: 67, from: 1, to: 10, due: 'اليوم، 9:00 م', status: 'not_started', today: true, instr: 'استمع إلى تلاوة الآيات ثلاث مرات قبل البدء، ثم احفظها على دفعتين (1–5 ثم 6–10). سجّل تلاوتك كاملة دون النظر إلى المصحف.' },
  { id: 'k2', type: 'review', title: 'مراجعة سورة النبأ', s: 78, from: 1, to: 40, due: 'اليوم، 9:00 م', status: 'in_progress', today: true, instr: 'راجع السورة كاملة مرتين، وركّز على مواضع التشابه بين الآيات 17–30.' },
  { id: 'k3', type: 'tajweed', title: 'تطبيق أحكام النون الساكنة والتنوين', s: 67, from: 11, to: 20, due: 'الثلاثاء 13 أكتوبر', status: 'not_started', instr: 'حدّد مواضع الإظهار والإخفاء في الآيات، ثم سجّل تلاوتك مع إظهار الغنّة بوضوح.' },
  { id: 'k5', type: 'review', title: 'مراجعة سورة النازعات', s: 79, from: 1, to: 46, due: 'أمس، 9:00 م', status: 'submitted', at: 'أمس 7:40 م', instr: 'راجع السورة كاملة وسجّلها دفعة واحدة.' },
  { id: 'k4', type: 'hifz', title: 'حفظ سورة القلم', s: 68, from: 1, to: 15, due: 'الخميس 8 أكتوبر', status: 'reviewed', at: 'الأربعاء 7 أكتوبر', instr: 'احفظ الآيات 1–15 وسجّلها دون النظر إلى المصحف.' },
  { id: 'k6', type: 'tajweed', title: 'المد الطبيعي والمد المتصل', s: 78, from: 1, to: 16, due: 'الإثنين 5 أكتوبر', status: 'reviewed', at: 'الأحد 4 أكتوبر', instr: 'طبّق أحكام المد الطبيعي والمتصل في الآيات المحددة.' },
];

export const initialFeedback = (): Record<string, Feedback> => ({
  k4: { teacher: 't1', date: 'الخميس 8 أكتوبر', dur: 142, scores: { hifz: 4, tajweed: 3, fluency: 4 }, decision: 'approve', notes: [{ t: 34, text: 'المدّ المنفصل هنا يحتاج إلى أربع حركات.' }, { t: 82, text: 'تردّد في بداية الآية التاسعة، أعد مراجعتها.' }, { t: 121, text: 'أحسنت في الوقف والابتداء.' }], voice: 42, general: 'حفظك متقن في أغلبه، مع تردد بسيط في الآيات 8–11. التجويد يحتاج إلى عناية بالمدود.', needs: 'الآيات 8–11، ومدّ المنفصل', next: 'أعد تسجيل الآيات 8–11 قبل جلسة الثلاثاء.' },
  k6: { teacher: 't1', date: 'الإثنين 5 أكتوبر', dur: 96, scores: { hifz: 4, tajweed: 4, fluency: 5 }, decision: 'approve', notes: [{ t: 21, text: 'مدّ متصل ممتاز.' }, { t: 63, text: 'لا تُطِل المد الطبيعي أكثر من حركتين.' }], voice: null, general: 'تطبيق جيد للأحكام، استمر على هذا المستوى.', needs: 'لا يوجد', next: 'انتقل إلى درس المدود وأنواعها.' },
});

export const initialRecordings = (): Record<string, Recording> => ({ k5: { dur: 134 }, k4: { dur: 142 }, k6: { dur: 96 } });

export const initialSessions = (): Session[] => [
  { id: 's1', t: 't1', day: 0, h: 17, type: 'فردية', dur: 45, status: 'confirmed', task: 'k1' },
  { id: 's2', t: 't3', day: 2, h: 18.5, type: 'فردية', dur: 45, status: 'confirmed', task: 'k3' },
  { id: 's0', t: 't1', past: 'الخميس 8 أكتوبر', h: 17, type: 'فردية', dur: 45, status: 'completed', task: 'k4', summary: 'راجعنا سورة القلم 1–15 وصحّحنا مواضع المدّ المنفصل. الحفظ جيد ويحتاج تثبيت الآيات 8–11.' },
];

export const initialOthers = (): OtherSubmission[] => [
  { id: 'o1', student: 'عمر الحربي', sid: 'u3', title: 'حفظ سورة الفجر', range: 'الآيات 1–14', dur: 98, at: 'اليوم 10:20 ص', status: 'submitted' },
  { id: 'o2', student: 'ليان الشمري', sid: 'u4', title: 'تجويد: أحكام الميم الساكنة', range: 'سورة البروج · الآيات 1–9', dur: 76, at: 'أمس 8:05 م', status: 'submitted' },
  { id: 'o3', student: 'عبدالله المطيري', sid: 'u5', title: 'مراجعة سورة الملك', range: 'الآيات 1–30', dur: 210, at: 'السبت 10 أكتوبر', status: 'reviewed' },
];

/** Deterministic weekly availability (hours in Riyadh time). Friday is off; s1 (today 5pm with t1) is pre-booked. */
export function generateAvailability(): Availability {
  const hrs: Record<string, number[]> = { t1: [16, 17, 18.5, 20, 21], t2: [15, 16, 17], t3: [18.5, 20, 21], t4: [] };
  const o: Availability = {};
  Object.keys(hrs).forEach((t) => {
    o[t] = DAYS.map((_, i) => i === 5 ? [] : hrs[t]
      .filter((_h, j) => (i + j) % 4 !== 3)
      .map((h, j) => ({ h, taken: (i * 3 + j) % 5 === 1 || (t === 't1' && i === 0 && h === 17) })));
  });
  return o;
}
