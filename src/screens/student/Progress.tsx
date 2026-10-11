import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { ProgressBar, Segmented, card, muted } from '@/components/ui';
import { rangeL, surahName } from '@/lib/format';
import { go, setState, useApp } from '@/store/store';

const CHART = {
  week: [['أحد', 25], ['إثنين', 30], ['ثلاثاء', 0], ['أربعاء', 20], ['خميس', 35], ['جمعة', 15], ['سبت', 28]],
  month: [['الأسبوع 1', 140], ['الأسبوع 2', 165], ['الأسبوع 3', 120], ['الأسبوع 4', 178]],
  q: [['أغسطس', 520], ['سبتمبر', 610], ['أكتوبر', 240]],
} as const;
const UNIT = { week: 'دقائق التلاوة والمراجعة يوميًا', month: 'دقائق التلاوة والمراجعة أسبوعيًا', q: 'دقائق التلاوة والمراجعة شهريًا' };

export const ATTENDANCE = [['الخميس 8 أكتوبر', 'حضر'], ['الثلاثاء 6 أكتوبر', 'حضر'], ['الأحد 4 أكتوبر', 'حضر'], ['الخميس 1 أكتوبر', 'غاب بعذر'], ['الثلاثاء 29 سبتمبر', 'حضر']] as const;

export function AttendancePill({ a, fs = 13 }: { a: string; fs?: number }) {
  const ok = a.startsWith('حضر');
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: fs, fontWeight: 700, padding: '3px 10px', borderRadius: 999, background: ok ? color.sage : color.warnBg, color: ok ? color.primary : color.warnInk }}>
      <Icon name={ok ? 'check' : 'minus'} size={18} />{a}
    </span>
  );
}

/** Teacher-attributed evaluations of the demo student — shared by progress, teacher's student profile. */
export function useEvals() {
  const s = useApp();
  return s.tasks.filter((t) => t.status === 'reviewed' && s.fb[t.id]).map((t) => {
    const f = s.fb[t.id];
    return { id: t.id, t: t.title, d: f.date, sc: `حفظ ${f.scores.hifz} · تجويد ${f.scores.tajweed} · طلاقة ${f.scores.fluency}` };
  });
}

export default function Progress() {
  const s = useApp(); const pr = s.progRange;
  const chart = CHART[pr]; const mx = Math.max(...chart.map((c) => c[1]));
  const evals = useEvals();
  const pending = s.tasks.filter((t) => t.status === 'submitted');
  const approved = [
    { t: 'سورة النبأ', d: 'كاملة · اعتمدها الشيخ عبدالرحمن' },
    { t: 'سورة النازعات', d: 'كاملة · اعتمدها الشيخ عبدالرحمن' },
    { t: 'سورة القلم', d: 'الآيات 1–15 · اعتمدها الشيخ عبدالرحمن' },
    ...s.tasks.filter((t) => t.type === 'hifz' && t.status === 'reviewed' && t.id !== 'k4' && s.fb[t.id]?.decision === 'approve')
      .map((t) => ({ t: 'سورة ' + surahName(t.s), d: `الآيات ${t.from}–${t.to} · اعتمدها المعلم` })),
  ];
  const metrics = [
    { label: 'الحفظ', val: '18%', sub: 'من جزء تبارك اعتمده المعلم', pct: 18 },
    { label: 'المراجعة', val: { week: '3 من 3', month: '12 من 14', q: '31 من 36' }[pr], sub: 'مهام مراجعة منجزة', pct: { week: 100, month: 86, q: 86 }[pr] },
    { label: 'التجويد', val: '3.5 من 5', sub: 'متوسط تقييم المعلم', pct: 70 },
  ];

  return (
    <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 style={{ margin: '12px 0 0', fontSize: 24, fontWeight: 800 }}>تقدمي</h1>
      <Segmented role="group" label="الفترة الزمنية" options={[['week', 'أسبوع'], ['month', 'شهر'], ['q', '3 أشهر']] as const} value={pr} onChange={(k) => setState({ progRange: k })} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,150px),1fr))', gap: 10 }}>
        {metrics.map((m) => (
          <div key={m.label} style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 13, color: color.muted, fontWeight: 700 }}>{m.label}</span>
            <span style={{ fontSize: 20, fontWeight: 800 }}>{m.val}</span>
            <span style={{ fontSize: 12, color: color.muted }}>{m.sub}</span>
            <ProgressBar pct={m.pct} h={6} />
          </div>
        ))}
      </div>
      <section style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>النشاط</h2>
        <p style={muted(12)}>{UNIT[pr]}</p>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 150 }} role="img" aria-label={`رسم بياني للنشاط: ${chart.map(([l, n]) => `${l} ${n}`).join('، ')}`}>
          {chart.map(([l, n]) => (
            <div key={l} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, justifyContent: 'flex-end', height: '100%' }}>
              <span style={{ fontFamily: font.latin, fontSize: 11, color: color.body }}>{n}</span>
              <span style={{ width: '100%', maxWidth: 36, borderRadius: '6px 6px 2px 2px', height: Math.max(4, Math.round((n / mx) * 120)), background: n ? color.primary : color.track }} />
              <span style={{ fontSize: 11, color: color.muted, whiteSpace: 'nowrap' }}>{l}</span>
            </div>
          ))}
        </div>
      </section>
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,300px),1fr))', gap: 10 }}>
        <div style={{ background: color.sageTint, borderRadius: 16, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: color.primary, display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="award" size={18} /> حفظ اعتمده المعلم</h2>
          {approved.map((a) => (
            <div key={a.t + a.d} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span style={{ color: color.primary, marginTop: 2 }}><Icon name="check" size={18} /></span>
              <div><p style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{a.t}</p><p style={{ margin: 0, fontSize: 12, color: color.body }}>{a.d}</p></div>
            </div>
          ))}
        </div>
        <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="upload" size={18} /> مهام منجزة بانتظار الاعتماد</h2>
          {pending.length ? pending.map((t) => (
            <button key={t.id} onClick={() => go('task', { id: t.id })} style={{ display: 'flex', gap: 8, alignItems: 'center', border: 'none', background: 'transparent', padding: 0, textAlign: 'right', cursor: 'pointer', minHeight: 44, color: color.ink }}>
              <div style={{ flex: 1 }}><p style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{t.title}</p><p style={muted(12)}>{rangeL(t)}</p></div>
              <span style={{ color: color.primary }}><Icon name="chevL" size={18} /></span>
            </button>
          )) : <p style={muted(14)}>لا توجد تسليمات بانتظار التقييم.</p>}
        </div>
      </section>
      <section style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>الحضور</h2>
          <span style={{ fontSize: 15, fontWeight: 800 }}>{{ week: '2 من 2', month: '7 من 8', q: '11 من 12' }[pr]} جلسة</span>
        </div>
        <ProgressBar pct={{ week: 100, month: 88, q: 92 }[pr]} />
        {ATTENDANCE.map(([d, a]) => (
          <div key={d} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 36, borderTop: `1px solid ${color.divider}`, paddingTop: 6 }}>
            <span style={{ fontSize: 14 }}>{d}</span><AttendancePill a={a} />
          </div>
        ))}
      </section>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>آخر التقييمات</h2>
        {evals.map((e) => (
          <button key={e.id} onClick={() => go('feedback', { id: e.id })} style={{ ...card, borderRadius: 14, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
            <span style={{ flex: 1 }}><span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{e.t}</span><span style={{ display: 'block', fontSize: 12, color: color.muted, marginTop: 2 }}>{e.d} · {e.sc}</span></span>
            <span style={{ color: color.primary }}><Icon name="chevL" /></span>
          </button>
        ))}
      </section>
      <p style={{ margin: 0, fontSize: 14, color: color.body, textAlign: 'center', padding: '8px 16px', lineHeight: 1.7 }}>تقدّمك يخصّك وحدك؛ لا نقارنك بغيرك. خطوات صغيرة منتظمة تصنع حفظًا ثابتًا.</p>
    </div>
  );
}
