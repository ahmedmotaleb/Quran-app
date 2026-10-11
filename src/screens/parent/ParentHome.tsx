import { color } from '@/theme/tokens';
import { Icon, type IconName } from '@/components/Icon';
import { Avatar, Badge, ProgressBar, card, muted } from '@/components/ui';
import type { BadgeKind } from '@/data/types';
import { rangeL, timeIn, typeIcon, tzLabel } from '@/lib/format';
import { go, setState, useApp } from '@/store/store';
import { teacherById, upcomingSessions } from '@/store/selectors';
import { AttendancePill } from '@/screens/student/Progress';
import { BRAND } from '@/theme/brand';

const KIDS = [['u1', 'يوسف', '14 سنة'], ['u2', 'سارة', '10 سنوات']] as const;

/** Parent view. Shows only children linked to this parent account. */
export default function ParentHome() {
  const s = useApp(); const isY = s.child === 'u1'; const tzL = tzLabel(s.tz);
  const up0 = upcomingSessions(s)[0];
  const next = isY ? (up0 ? { who: up0.teacherName, when: up0.when } : null) : { who: 'الأستاذة مريم القحطاني', when: `غدًا · ${timeIn(s.tz, 16)}` };
  const att = isY
    ? [['الخميس 8 أكتوبر', 'حضر'], ['الثلاثاء 6 أكتوبر', 'حضر'], ['الأحد 4 أكتوبر', 'حضر'], ['الخميس 1 أكتوبر', 'غاب بعذر']]
    : [['الخميس 8 أكتوبر', 'حضرت'], ['الإثنين 5 أكتوبر', 'حضرت'], ['الخميس 1 أكتوبر', 'حضرت'], ['الإثنين 28 سبتمبر', 'حضرت']];
  const tasks: { id: string; title: string; range: string; kind: BadgeKind; icon: IconName }[] = isY
    ? s.tasks.filter((t) => t.status !== 'reviewed').slice(0, 4).map((t) => ({ id: t.id, title: t.title, range: rangeL(t), kind: t.status, icon: typeIcon(t.type) }))
    : [{ id: 'a', title: 'حفظ سورة الطارق', range: 'سورة الطارق · الآيات 1–10', kind: 'in_progress', icon: 'book' }, { id: 'b', title: 'مراجعة سورة الأعلى', range: 'سورة الأعلى · الآيات 1–19', kind: 'not_started', icon: 'repeat' }];
  const prog = isY
    ? [{ l: 'الحفظ المعتمد', v: '18% من جزء تبارك', p: 18 }, { l: 'المراجعة', v: '12 من 14 مهمة', p: 86 }, { l: 'التجويد', v: '3.5 من 5', p: 70 }]
    : [{ l: 'الحفظ المعتمد', v: '62% من جزء عمّ', p: 62 }, { l: 'المراجعة', v: '8 من 8 مهام', p: 100 }, { l: 'التجويد', v: '4 من 5', p: 80 }];

  const yLast = s.tasks.filter((t) => t.status === 'reviewed' && s.fb[t.id]).sort((a, b) => Number(s.fb[b.id].date === 'اليوم') - Number(s.fb[a.id].date === 'اليوم'))[0];
  const yfb = yLast && s.fb[yLast.id];
  const fb = isY
    ? (yfb ? { t: yLast.title, date: yfb.date, teacher: teacherById(yfb.teacher).name, note: yfb.general, sc: `الحفظ ${yfb.scores.hifz} · التجويد ${yfb.scores.tajweed} · الطلاقة ${yfb.scores.fluency} (من 5)`, open: () => go('feedback', { id: yLast.id }) } : null)
    : { t: 'حفظ سورة الأعلى', date: 'الخميس 8 أكتوبر', teacher: 'الأستاذة مريم القحطاني', note: 'سارة ملتزمة ومتحمسة، حفظها ثابت. نعمل على تحسين مخرج حرف العين.', sc: 'الحفظ 5 · التجويد 4 · الطلاقة 4 (من 5)', open: null };

  return (
    <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 56 }}>
        <img src="/assets/halqa-mark.png" alt={BRAND.ar} style={{ width: 38, height: 38, objectFit: 'contain' }} />
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 21, fontWeight: 800 }}>متابعة الأبناء</h1>
          <p style={muted(13)}>تظهر بيانات أبنائك المرتبطين فقط</p>
        </div>
        <button onClick={() => go('account')} aria-label="حسابي" style={{ width: 48, height: 48, borderRadius: 14, border: `1px solid ${color.border}`, background: color.card, color: color.primary, display: 'grid', placeItems: 'center', cursor: 'pointer' }}><Icon name="user" /></button>
      </header>
      <div role="tablist" aria-label="اختر الابن أو الابنة" style={{ display: 'flex', gap: 10 }}>
        {KIDS.map(([k, l, a]) => {
          const on = s.child === k;
          return (
            <button key={k} role="tab" aria-selected={on} onClick={() => setState({ child: k })}
              style={{ flex: 1, minHeight: 64, borderRadius: 16, border: `1.5px solid ${on ? color.primary : color.borderChip}`, background: on ? color.primary : color.card, color: on ? color.ivory : color.ink, display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', cursor: 'pointer', textAlign: 'right' }}>
              <Avatar ini={l[0]} size={40} fs={17} />
              <span><span style={{ display: 'block', fontSize: 16, fontWeight: 700 }}>{l}</span><span style={{ display: 'block', fontSize: 12, color: on ? color.sage : color.muted }}>{a}</span></span>
            </button>
          );
        })}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,300px),1fr))', gap: 12 }}>
        {next && (
          <section style={{ background: color.primary, color: color.ivory, borderRadius: 18, padding: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, color: color.sage }}>الجلسة القادمة لـ {isY ? 'يوسف' : 'سارة'}</span>
            <span style={{ fontSize: 18, fontWeight: 700 }}>{next.when}</span>
            <span style={{ fontSize: 14, color: '#E5EDE4' }}>{next.who}</span>
            <span style={{ fontSize: 12, color: color.liveSub }}>{tzL}</span>
          </section>
        )}
        <section style={{ ...card, borderRadius: 18, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>الحضور</h2>
            <span style={{ fontSize: 15, fontWeight: 800 }}>{isY ? '11 من 12' : '8 من 8'}</span>
          </div>
          <ProgressBar pct={isY ? 92 : 100} />
          {att.map(([d, a]) => (
            <div key={d} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 34 }}><span style={{ fontSize: 14 }}>{d}</span><AttendancePill a={a} fs={12} /></div>
          ))}
        </section>
      </div>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>الواجبات الحالية</h2>
        {tasks.map((t) => (
          <div key={t.id} style={{ ...card, borderRadius: 14, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: color.primary }}><Icon name={t.icon} /></span>
            <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{t.title}</span><span style={{ display: 'block', fontSize: 12, color: color.muted }}>{t.range}</span></span>
            <Badge kind={t.kind} size="sm" />
          </div>
        ))}
      </section>
      <section style={{ ...card, borderRadius: 18, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>التقدّم</h2>
        {prog.map((p) => (
          <div key={p.l} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}><span>{p.l}</span><strong>{p.v}</strong></div>
            <ProgressBar pct={p.p} h={6} />
          </div>
        ))}
      </section>
      {fb && (
        <section style={{ background: color.sageTint, borderRadius: 18, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ margin: 0, fontSize: 13, color: color.primary, fontWeight: 700 }}>أحدث تقييم · {fb.date}</p>
          <p style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{fb.t}</p>
          <p style={{ margin: 0, fontSize: 13, color: color.body }}>{fb.sc}</p>
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.8 }}>«{fb.note}»</p>
          <p style={muted(13)}>— {fb.teacher}</p>
          {fb.open && <button onClick={fb.open} style={{ alignSelf: 'flex-start', minHeight: 44, padding: '0 14px', borderRadius: 10, border: `1.5px solid ${color.primary}`, background: 'transparent', color: color.primary, fontWeight: 700, cursor: 'pointer' }}>عرض التقييم كاملًا</button>}
        </section>
      )}
    </div>
  );
}
