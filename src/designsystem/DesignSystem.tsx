import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { color, font, radius } from '@/theme/tokens';
import { Icon, type IconName } from '@/components/Icon';
import { Badge, Chips, FieldError, Segmented, Spinner, Switch, dangerOutlineBtn, inputStyle, labelStyle, outlineBtn, primaryBtn, sageBtn } from '@/components/ui';
import type { BadgeKind } from '@/data/types';
import { fetchAyah } from '@/services/quran';

/**
 * Living design-system reference (project/Halqa Design System.dc.html), rendered with the
 * app's real tokens and components so it can't drift from the product.
 */
const card: CSSProperties = { background: color.card, border: `1px solid ${color.border}`, borderRadius: 16 };

const COLORS: [string, string, string][] = [
  ['أخضر حَلْقة', color.primary, 'الإجراءات الأساسية والتنقل'], ['أخضر عميق', color.liveBg, 'الجلسة المباشرة'],
  ['مريمية', color.sage, 'خلفيات ثانوية ونجاح'], ['مريمية فاتحة', color.sageTint, 'بطاقات التوجيه'],
  ['عاجي', color.ivory, 'خلفية التطبيق'], ['ورقي', color.card, 'البطاقات والحقول'],
  ['ذهبي', color.gold, 'علامات التوقيت والمرجعيات فقط'], ['حبر', color.ink, 'النص الأساسي'],
  ['رمادي مخضر', color.muted, 'النص الثانوي'], ['طوبي', color.dangerInk, 'الأخطاء والإجراءات الحساسة'],
];
const TYPE: [string, string, number, number, string][] = [
  ['Tajawal 800 / 28', font.ui, 28, 800, 'عنوان الشاشة'], ['Tajawal 700 / 18', font.ui, 18, 700, 'عنوان البطاقة'],
  ['Tajawal 500 / 16', font.ui, 16, 500, 'نص الجسم والتوجيهات'], ['Tajawal 500 / 13', font.ui, 13, 500, 'نص مساعد وتوقيت'],
  ['Manrope 600 / 20', font.latin, 20, 600, '05:42 · 9:41'],
];
const BADGES: BadgeKind[] = ['not_started', 'in_progress', 'submitted', 'reviewed', 'confirmed', 'cancelled', 'late', 'newsub'];
const RULES: [string, string][] = [
  ['RTL أولًا', 'التخطيط والأيقونات الاتجاهية معكوسة؛ الأرقام والأوقات في عزل LTR.'],
  ['أهداف لمس 44px+', 'وأغلب الأزرار الأساسية 52–54px.'],
  ['الحالة ليست لونًا فقط', 'كل شارة تحمل نصًا واضحًا وأيقونة.'],
  ['تحفيز هادئ', 'لا مقارنة بين الطلاب، ولا لوحات صدارة، ولا ألعاب.'],
  ['الوقت مع المنطقة الزمنية', 'كل موعد يُعرض بتوقيت المستخدم مع ذكر المنطقة.'],
  ['صدق النموذج', 'كل ما لا يعمل فعليًا (رفع، اتصال، دفع) موسوم كتجريبي.'],
];
const ICONS: IconName[] = ['home', 'plan', 'users', 'chart', 'user', 'book', 'mic', 'cal', 'play', 'bell', 'bookmark', 'repeat', 'clock', 'video', 'upload', 'globe', 'award', 'alert'];

/** Quran text is only ever loaded from the trusted source — never typed by hand, even in a style guide. */
function QuranSample({ refId, size }: { refId: string; size: number }) {
  const [st, setSt] = useState<{ text?: string; err?: boolean }>({});
  const load = () => { setSt({}); fetchAyah(refId).then((text) => setSt({ text })).catch(() => setSt({ err: true })); };
  useEffect(load, [refId]);
  if (st.text) return <span lang="ar" style={{ fontFamily: font.quran, fontSize: size, lineHeight: 2.2 }}>{st.text}</span>;
  if (st.err) return (
    <span role="alert" style={{ fontSize: 13, color: color.muted, display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      تعذّر تحميل النص من المصدر المعتمد ({refId}).
      <button onClick={load} style={{ minHeight: 36, padding: '0 10px', borderRadius: 10, border: `1px solid ${color.borderStrong}`, background: color.card, color: color.primary, fontWeight: 700, cursor: 'pointer' }}>إعادة المحاولة</button>
    </span>
  );
  return <Spinner />;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}><h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>{title}</h2>{children}</section>;
}

export default function DesignSystem() {
  const [seg, setSeg] = useState<'hifz' | 'review' | 'tajweed'>('hifz');
  const [chips, setChips] = useState<string[]>(['الأحد']);
  const [sw, setSw] = useState(true);
  useEffect(() => { document.title = 'حَلْقة | نظام التصميم'; return () => { document.title = 'حَلْقة | HALQA'; }; }, []);

  return (
    <div dir="rtl" lang="ar" style={{ minHeight: '100vh', background: color.ivory }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '40px clamp(16px,4vw,48px) 64px', display: 'flex', flexDirection: 'column', gap: 40 }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
          <img src="/assets/halqa-logo.png" alt="حَلْقة HALQA" style={{ width: 140, height: 140, objectFit: 'contain' }} />
          <div style={{ flex: 1, minWidth: 240 }}>
            <h1 style={{ margin: 0, fontSize: 34, fontWeight: 800 }}>نظام تصميم حَلْقة</h1>
            <p style={{ margin: '6px 0 0', fontSize: 16, color: color.muted, lineHeight: 1.7 }}>هادئ، واضح، عربي أولًا (RTL). اللون الأخضر للإجراءات، والذهبي للعلامات والتمييز فقط. تُعرض هنا المكوّنات الفعلية من شيفرة التطبيق.</p>
          </div>
          <a href="#/" style={{ fontSize: 15, fontWeight: 700, minHeight: 44, display: 'flex', alignItems: 'center' }}>← العودة إلى النموذج</a>
        </header>

        <Section title="الألوان">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 12 }}>
            {COLORS.map(([n, hex, use]) => (
              <div key={n} style={{ ...card, overflow: 'hidden' }}>
                <div style={{ height: 72, background: hex, borderBottom: `1px solid ${color.border}` }} />
                <div style={{ padding: '10px 12px' }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{n}</p>
                  <p dir="ltr" style={{ margin: '2px 0 0', fontFamily: font.latin, fontSize: 12, color: color.muted, textAlign: 'right' }}>{hex}</p>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: color.body }}>{use}</p>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="الخطوط">
          <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {TYPE.map(([spec, ff, size, w, sample]) => (
              <div key={spec} style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap', borderBottom: `1px solid ${color.divider}`, paddingBottom: 12 }}>
                <span dir="ltr" style={{ width: 150, fontFamily: font.latin, fontSize: 12, color: color.muted }}>{spec}</span>
                <span dir={ff === font.latin ? 'ltr' : undefined} style={{ flex: 1, fontFamily: ff, fontSize: size, fontWeight: w }}>{sample}</span>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap', borderBottom: `1px solid ${color.divider}`, paddingBottom: 12 }}>
              <span dir="ltr" style={{ width: 150, fontFamily: font.latin, fontSize: 12, color: color.muted }}>Amiri Quran / 26</span>
              <span style={{ flex: 1 }}><QuranSample refId="67:2" size={26} /></span>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: color.muted, lineHeight: 1.7 }}>Tajawal للواجهة، Amiri Quran للنص القرآني فقط، Manrope للأرقام اللاتينية والأوقات والمدد. الحد الأدنى للنص 12px، ونص الجسم 15–16px.</p>
          </div>
        </Section>

        <Section title="المكوّنات الأساسية">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,300px),1fr))', gap: 14 }}>
            <div style={{ ...card, padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: color.muted }}>الأزرار · ارتفاع 52–54px · زوايا {radius.lg}px</p>
              <button style={primaryBtn()}>أساسي</button>
              <button style={sageBtn()}>ثانوي</button>
              <button style={outlineBtn(52, 16)}>محدّد</button>
              <button style={dangerOutlineBtn(52, 16)}>إجراء حساس</button>
            </div>
            <div style={{ ...card, padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: color.muted }}>شارات الحالة · نص + أيقونة دائمًا</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{BADGES.map((b) => <Badge key={b} kind={b} />)}</div>
              <p style={{ margin: '6px 0 0', fontSize: 14, fontWeight: 700, color: color.muted }}>حقل إدخال · خطأ</p>
              <label htmlFor="ds-email" style={labelStyle}>البريد الإلكتروني</label>
              <input id="ds-email" dir="ltr" defaultValue="name@" aria-invalid style={inputStyle(true, true)} />
              <FieldError msg="صيغة البريد الإلكتروني غير صحيحة" />
            </div>
            <div style={{ ...card, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: color.muted }}>التبويبات والاختيارات والمفاتيح</p>
              <Segmented role="tablist" options={[['hifz', 'حفظ'], ['review', 'مراجعة'], ['tajweed', 'تجويد']] as const} value={seg} onChange={setSeg} />
              <Chips h={44} options={[['الأحد', 'الأحد'], ['الثلاثاء', 'الثلاثاء'], ['الخميس', 'الخميس']] as const} value={chips} onChange={(k) => setChips(chips.includes(k) ? chips.filter((x) => x !== k) : [...chips, k])} />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 52 }}><span style={{ fontSize: 15 }}>تذكير بالواجبات</span><Switch on={sw} onToggle={() => setSw(!sw)} label="تذكير بالواجبات" /></div>
            </div>
            <div style={{ ...card, padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: color.muted }}>النص القرآني</p>
              <p style={{ margin: 0, background: '#E5EEE3', borderRadius: 10, padding: '4px 10px' }}><QuranSample refId="1:1" size={26} /></p>
              <p style={{ margin: 0, fontSize: 13, color: color.muted, lineHeight: 1.7 }}>يُحمَّل النص من مصدر معتمد فقط (Tanzil عبر alquran.cloud) ولا يُكتب يدويًا. التمييز بخلفية خضراء هادئة؛ الآية المُشغَّلة بخط ذهبي سفلي.</p>
            </div>
            <div style={{ ...card, padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: color.muted }}>الأيقونات · خطية 1.8 · 18 / 22 / 30px</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, color: color.primary }}>
                {ICONS.map((i) => <span key={i} title={i} style={{ width: 40, height: 40, borderRadius: 12, background: color.sageTint, display: 'grid', placeItems: 'center' }}><Icon name={i} /></span>)}
              </div>
            </div>
          </div>
        </Section>

        <Section title="المبادئ">
          {RULES.map(([t, d]) => <p key={t} style={{ margin: 0, fontSize: 15, lineHeight: 1.8, ...card, borderRadius: 12, padding: '12px 16px' }}><strong>{t}</strong> — {d}</p>)}
        </Section>
      </div>
    </div>
  );
}
