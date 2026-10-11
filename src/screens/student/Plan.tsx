import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { BackHeader, Badge, PlayerBar, card, muted, primaryBtn, sageBtn } from '@/components/ui';
import { rangeL, typeIcon, typeL } from '@/lib/format';
import type { TaskType } from '@/data/types';
import { go, setState, useApp } from '@/store/store';
import { teacherById } from '@/store/selectors';
import { fmt } from '@/lib/format';

const TABS: [TaskType, string][] = [['hifz', 'حفظ'], ['review', 'مراجعة'], ['tajweed', 'تجويد']];

export default function Plan() {
  const s = useApp();
  const pt = s.planTab;
  const ptasks = s.tasks.filter((t) => t.type === pt);
  const active = ptasks.filter((t) => t.status !== 'reviewed');
  const done = ptasks.filter((t) => t.status === 'reviewed');
  const cnt = (k: TaskType) => s.tasks.filter((t) => t.type === k && t.status !== 'reviewed').length;

  return (
    <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h1 style={{ margin: '12px 0 0', fontSize: 24, fontWeight: 800 }}>تعلمي</h1>
      <div role="tablist" style={{ display: 'flex', background: color.sunken, borderRadius: 14, padding: 4, gap: 4 }}>
        {TABS.map(([k, l]) => {
          const on = pt === k;
          return (
            <button key={k} role="tab" aria-selected={on} onClick={() => setState({ planTab: k })}
              style={{ flex: 1, minHeight: 48, border: 'none', borderRadius: 11, background: on ? color.primary : 'transparent', color: on ? color.ivory : color.body, fontSize: 15, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, cursor: 'pointer' }}>
              {l}
              <span style={{ minWidth: 22, height: 22, padding: '0 6px', borderRadius: 999, background: on ? 'rgba(247,243,232,.2)' : color.track, fontFamily: font.latin, fontSize: 12, display: 'grid', placeItems: 'center' }}>{cnt(k)}</span>
            </button>
          );
        })}
      </div>
      {active.length === 0 && (
        <div style={{ textAlign: 'center', padding: '28px 16px', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
          <span style={{ color: color.primary }}><Icon name="check" size={30} /></span>
          <p style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>لا توجد مهام لليوم</p>
          <p style={muted(14)}>أنجزت كل مهام هذا القسم.</p>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(min(100%,320px),1fr))', gap: 10 }}>
        {active.map((t) => (
          <button key={t.id} onClick={() => go('task', { id: t.id })} style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 10, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
            <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', gap: 8 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: color.muted, fontWeight: 700 }}><Icon name={typeIcon(t.type)} /> {typeL(t.type)}</span>
              <Badge kind={t.status} />
            </span>
            <span style={{ fontSize: 18, fontWeight: 700 }}>{t.title}</span>
            <span style={{ fontSize: 14, color: color.body }}>{rangeL(t)}</span>
            <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: color.muted }}><Icon name="clock" size={18} /> {t.due}</span>
              <span style={{ color: color.primary }}><Icon name="chevL" /></span>
            </span>
          </button>
        ))}
      </div>
      {done.length > 0 && (
        <>
          <h2 style={{ margin: '8px 0 0', fontSize: 16, fontWeight: 700, color: color.muted }}>تمت مراجعتها</h2>
          {done.map((t) => (
            <button key={t.id} onClick={() => go('task', { id: t.id })} style={{ background: 'transparent', border: `1px solid ${color.border}`, borderRadius: 16, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
              <span style={{ flex: 1 }}>
                <span style={{ display: 'block', fontSize: 16, fontWeight: 700 }}>{t.title}</span>
                <span style={{ display: 'block', fontSize: 13, color: color.muted, marginTop: 2 }}>{rangeL(t)}</span>
              </span>
              <Badge kind={t.status} />
            </button>
          ))}
        </>
      )}
    </div>
  );
}

const STEPS = ['لم تبدأ', 'قيد التنفيذ', 'تم التسليم', 'تمت المراجعة'];
const ORDER = ['not_started', 'in_progress', 'submitted', 'reviewed'];

export function TaskDetail() {
  const s = useApp();
  const t = s.tasks.find((x) => x.id === s.params.id) || s.tasks[0];
  if (!t) return <BackHeader title="تفاصيل المهمة" />;
  // "Needs repeat" sits back on the in-progress step.
  const idx = ORDER.indexOf(t.status === 'needs_repeat' ? 'in_progress' : t.status);
  const rec = s.recs[t.id];
  const canRec = t.status === 'not_started' || t.status === 'in_progress' || t.status === 'needs_repeat';

  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <BackHeader title="تفاصيل المهمة" sticky />
      <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 16, flex: 1 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: color.muted, fontWeight: 700 }}><Icon name={typeIcon(t.type)} /> {typeL(t.type)}</span>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>{t.title}</h2>
          <Badge kind={t.status} size="lg" style={{ alignSelf: 'flex-start' }} />
        </div>
        <div style={{ ...card, padding: '4px 16px' }}>
          {([['النطاق', rangeL(t)], ['موعد التسليم', t.due], ['المعلم', t.teacherName ?? teacherById('t1').name]] as const).map(([k, v], i) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '12px 0', borderBottom: i < 2 ? `1px solid ${color.divider}` : 'none' }}>
              <span style={{ fontSize: 14, color: color.muted }}>{k}</span><span style={{ fontSize: 15, fontWeight: 700 }}>{v}</span>
            </div>
          ))}
        </div>
        <div style={{ background: color.sageTint, borderRadius: 16, padding: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: color.primary, display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="note" size={18} /> توجيهات المعلم</p>
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.8, color: color.ink, textWrap: 'pretty' }}>{t.instr}</p>
        </div>
        <ol aria-label="حالة المهمة" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', alignItems: 'flex-start' }}>
          {STEPS.map((label, i) => {
            const done = i <= idx;
            return (
              <li key={label} aria-current={i === idx ? 'step' : undefined} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, position: 'relative' }}>
                <span style={{ width: 30, height: 30, borderRadius: '50%', border: `1.5px solid ${done ? color.primary : color.borderStrong}`, background: done ? color.primary : color.card, color: done ? color.ivory : color.faint, display: 'grid', placeItems: 'center', fontFamily: font.latin, fontSize: 12, fontWeight: 700, position: 'relative', zIndex: 1 }}>
                  {done ? <Icon name="check" size={18} /> : String(i + 1)}
                </span>
                <span style={{ fontSize: 12, textAlign: 'center', color: color.ink, fontWeight: i === idx ? 800 : 500 }}>{label}</span>
                {i < 3 && <span style={{ position: 'absolute', top: 15, right: 'calc(50% + 15px)', left: 'calc(-50% + 15px)', height: 2, background: i < idx ? color.primary : color.borderChip }} />}
              </li>
            );
          })}
        </ol>
        {t.status === 'submitted' && (
          <div style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>تسليمك ({rec ? fmt(rec.dur) : ''})</p>
            <PlayerBar k={'sub-' + t.id} dur={rec?.dur || 0} url={rec?.url} trackH={28} />
            <p style={muted(13, { display: 'flex', gap: 6, alignItems: 'center' })}><Icon name="clock" size={18} /> بانتظار تقييم المعلم. سيصلك إشعار عند وصوله.</p>
          </div>
        )}
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 10, position: 'sticky', bottom: 0, background: color.ivory, padding: '10px 0 4px' }}>
          {canRec && <button onClick={() => go('record', { task: t.id })} style={primaryBtn()}><Icon name="mic" /> سجّل تلاوتك</button>}
          {t.status === 'reviewed' && !s.fb[t.id] && <p style={muted(13, { textAlign: 'center' })}>اعتمد المعلم هذه المهمة. عرض تفاصيل التقييم داخل التطبيق لم يُفعَّل بعد.</p>}
          {t.status === 'reviewed' && s.fb[t.id] && <button onClick={() => go('feedback', { id: t.id })} style={primaryBtn()}><Icon name="award" /> عرض تقييم المعلم</button>}
          <button onClick={() => go('mushaf', { s: t.s, from: t.from, to: t.to })} style={sageBtn()}><Icon name="book" /> افتح النطاق في المصحف</button>
        </div>
      </div>
    </div>
  );
}
