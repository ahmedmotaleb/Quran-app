import type { CSSProperties } from 'react';
import { color, font } from '@/theme/tokens';
import { SCREEN_NAMES } from '@/data/demo';
import { reset, restartSplash, setState, simEval, toast, up, useApp, type DataState, type DeviceKey } from '@/store/store';
import { BRAND } from '@/theme/brand';

/**
 * Prototype control panel (desktop only). Lets reviewers jump between roles, run the
 * four end-to-end flows, force data states and simulate failures. Not part of the product UI.
 */
const box: CSSProperties = { background: color.ivory, border: `1px solid ${color.borderChip}`, borderRadius: 16, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 };
const h: CSSProperties = { margin: 0, fontSize: 14, fontWeight: 700, color: color.primary };
const ghost: CSSProperties = { minHeight: 40, padding: '0 12px', borderRadius: 10, border: `1px solid ${color.borderStrong}`, background: color.card, color: color.primary, fontSize: 13, fontWeight: 700, cursor: 'pointer' };
const pill = (on: boolean, extra: CSSProperties = {}): CSSProperties => ({ minHeight: 40, padding: '0 12px', borderRadius: 999, border: `1.5px solid ${on ? color.primary : color.borderStrong}`, background: on ? color.primary : color.card, color: on ? color.ivory : color.primary, fontSize: 13, fontWeight: 700, cursor: 'pointer', ...extra });
const loginAs = (email: string) => reset('login', null, { login: { email, pw: 'halqa123', show: false, errors: {}, loading: false, parent: false } });

const FLOWS = [
  { n: '1', title: 'تسليم تلاوة ومشاهدة التقييم', steps: 'الدخول ← الرئيسية ← واجب الملك ← تسجيل ← تسليم ← «محاكاة تقييم المعلم» ← التقييم', start: () => loginAs('yousef@halqa.app') },
  { n: '2', title: 'حجز جلسة', steps: 'الحلقات ← معلم ← اختيار موعد ← مراجعة ← تأكيد ← تفاصيل الجلسة', start: () => reset('circles', 'student', { circTab: 'teachers' }) },
  { n: '3', title: 'تقييم المعلم لتسجيل', steps: 'دخول المعلم ← تسجيل ينتظر ← ملاحظات بالتوقيت ← تقييم ← إرسال', start: () => loginAs('teacher@halqa.app') },
  { n: '4', title: 'متابعة ولي الأمر', steps: 'دخول ولي الأمر ← اختيار الابن ← الحضور والتقدم والتقييم', start: () => loginAs('parent@halqa.app') },
];

export default function DemoPanel() {
  const s = useApp();
  const roleL = s.role ? ` · ${{ student: 'طالب', teacher: 'معلم', parent: 'ولي أمر', admin: 'إدارة' }[s.role]}` : '';
  const quick = [
    { label: 'شاشة البداية', click: restartSplash },
    { label: 'الطالب', click: () => reset('home', 'student') },
    { label: 'المعلم', click: () => reset('tdash', 'teacher') },
    { label: 'ولي الأمر', click: () => reset('phome', 'parent') },
  ];
  const ds: [DataState, string][] = [['normal', 'طبيعي'], ['loading', 'تحميل'], ['empty', 'لا بيانات'], ['error', 'خطأ'], ['offline', 'بدون اتصال']];
  const devs: [DeviceKey, string][] = [['360', '360'], ['390', '390'], ['tablet', 'تابلت']];

  return (
    <aside aria-label="لوحة النموذج" style={{ flex: '0 1 330px', maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <img src="/assets/halqa-mark.png" alt="" style={{ width: 44, height: 44, objectFit: 'contain' }} />
        <div>
          <p style={{ margin: 0, fontSize: 20, fontWeight: 800, color: color.primary }}>{BRAND.ar} · نموذج تفاعلي</p>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: color.muted }}>بيانات عرض تجريبية — لا تُرسل أي بيانات إلى خادم</p>
        </div>
      </div>
      <div style={box}>
        <p style={h}>الانتقال السريع</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {quick.map((q) => <button key={q.label} onClick={q.click} style={{ minHeight: 44, borderRadius: 12, border: `1px solid ${color.borderStrong}`, background: color.card, color: color.primary, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>{q.label}</button>)}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a href="/admin/" style={{ flex: 1, minHeight: 44, borderRadius: 12, background: color.primary, color: color.ivory, fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}>لوحة الإدارة (ديسكتوب)</a>
          <a href="#/design-system" style={{ flex: 1, minHeight: 44, borderRadius: 12, background: color.sage, color: color.primary, fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}>نظام التصميم</a>
        </div>
        <p style={{ margin: 0, fontSize: 13, color: color.muted }}>الشاشة الحالية: <strong style={{ color: color.ink }}>{SCREEN_NAMES[s.screen]}{roleL}</strong></p>
      </div>
      <div style={box}>
        <p style={h}>مسارات التجربة</p>
        {FLOWS.map((f) => (
          <div key={f.n} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: 10, borderRadius: 12, background: color.card, border: `1px solid ${color.border}` }}>
            <span style={{ width: 28, height: 28, borderRadius: '50%', background: color.primary, color: color.ivory, fontFamily: font.latin, fontWeight: 700, fontSize: 13, display: 'grid', placeItems: 'center', flexShrink: 0 }}>{f.n}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{f.title}</p>
              <p style={{ margin: '3px 0 0', fontSize: 12, color: color.muted, lineHeight: 1.6 }}>{f.steps}</p>
            </div>
            <button onClick={f.start} style={{ minHeight: 40, padding: '0 12px', borderRadius: 10, border: 'none', background: color.sage, color: color.primary, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>ابدأ</button>
          </div>
        ))}
      </div>
      <div style={box}>
        <p style={h}>حالة البيانات في الشاشات الرئيسية</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {ds.map(([k, l]) => <button key={k} aria-pressed={s.ds === k} onClick={() => setState({ ds: k })} style={pill(s.ds === k)}>{l}</button>)}
        </div>
        <p style={{ ...h, marginTop: 4 }}>محاكاة</p>
        {([['uploadFail', 'فشل رفع التسجيل'], ['slotTaken', 'الموعد المختار لم يعد متاحًا عند التأكيد']] as const).map(([k, l]) => (
          <label key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 13, minHeight: 40, cursor: 'pointer' }}>
            <span>{l}</span>
            <input type="checkbox" checked={s.sim[k]} onChange={() => up('sim', { [k]: !s.sim[k] })} style={{ width: 20, height: 20, accentColor: color.primary }} />
          </label>
        ))}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button onClick={simEval} style={ghost}>محاكاة تقييم المعلم لآخر تسليم</button>
          <button onClick={() => { if (s.screen !== 'live' || s.live.phase !== 'live') { toast('ادخل جلسة مباشرة أولًا', 'alert'); return; } up('live', { phase: 'reconnecting', attempt: 1, c: 0 }); }} style={ghost}>محاكاة انقطاع الجلسة</button>
          <button onClick={() => { if (s.screen !== 'live') { toast('ادخل جلسة مباشرة أولًا', 'alert'); return; } up('live', { phase: 'failed' }); }} style={ghost}>محاكاة فشل الاتصال</button>
        </div>
        <p style={{ ...h, marginTop: 4 }}>عرض الجهاز</p>
        <div style={{ display: 'flex', gap: 6 }}>
          {devs.map(([k, l]) => <button key={k} aria-pressed={s.device === k} onClick={() => setState({ device: k })} style={pill(s.device === k, { flex: 1, borderRadius: 10 })}>{l}</button>)}
        </div>
      </div>
    </aside>
  );
}
