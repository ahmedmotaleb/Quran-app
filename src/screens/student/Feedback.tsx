import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { Avatar, BackHeader, PlayerBar, card, muted, outlineBtn, primaryBtn, usePlayer } from '@/components/ui';
import { fmt, rangeL, scoreL } from '@/lib/format';
import { go, tab, useApp } from '@/store/store';
import { teacherById } from '@/store/selectors';

export default function Feedback() {
  const s = useApp();
  const id = s.params.id!;
  const t = s.tasks.find((x) => x.id === id);
  const f = s.fb[id];
  const voice = usePlayer('voice-' + id, f?.voice || 0, f?.voiceUrl ?? null);
  if (!t || !f) return <BackHeader title="تقييم المعلم" sticky />;
  const th = teacherById(f.teacher);
  const approved = f.decision === 'approve';
  const recUrl = s.recs[id]?.url;
  const pkey = 'fb-' + id;

  return (
    <div>
      <BackHeader title="تقييم المعلم" sticky />
      <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Avatar ini={th.ini} size={48} fs={20} />
          <div style={{ flex: 1 }}>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{th.name}</p>
            <p style={muted(13, { margin: '2px 0 0' })}>قيّم تسجيلك · {f.date}</p>
          </div>
        </div>
        <div style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <p style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{t.title}</p>
          <p style={muted(14)}>{rangeL(t)}</p>
          <span style={{ alignSelf: 'flex-start', marginTop: 4, display: 'inline-flex', gap: 4, alignItems: 'center', padding: '5px 12px', borderRadius: 999, background: approved ? color.primary : color.warnBg, color: approved ? color.ivory : color.warnInk, fontSize: 13, fontWeight: 700 }}>
            <Icon name={approved ? 'check' : 'refresh'} size={18} /> {approved ? 'اعتمد المعلم الحفظ' : 'يحتاج إلى إعادة'}
          </span>
        </div>
        <section aria-label="التسجيل وملاحظات التوقيت" style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {s.recs[id]?.gone
            ? <p style={muted(14, { display: 'flex', gap: 6, alignItems: 'center' })}><Icon name="clock" size={18} /> حُذف التسجيل تلقائيًا بعد 48 ساعة من التقييم. بقيت الدرجات والملاحظات.</p>
            : <PlayerBar k={pkey} dur={f.dur} url={recUrl} notes={f.notes} />}
          {f.notes.map((n, i) => (
            <FbNote key={i} t={n.t} text={n.text} pkey={pkey} dur={f.dur} url={recUrl} />
          ))}
        </section>
        <section aria-label="الدرجات" style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {([['الحفظ', 'hifz'], ['التجويد', 'tajweed'], ['الطلاقة', 'fluency']] as const).map(([l, k]) => {
            const v = f.scores[k];
            return (
              <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15 }}><span style={{ fontWeight: 700 }}>{l}</span><span><strong>{v} من 5</strong> · {scoreL(v)}</span></div>
                <div style={{ display: 'flex', gap: 4 }} aria-hidden="true">
                  {[1, 2, 3, 4, 5].map((i) => <span key={i} style={{ flex: 1, height: 8, borderRadius: 4, background: i <= v ? color.primary : color.track }} />)}
                </div>
              </div>
            );
          })}
          <p style={muted(12)}>الدرجات من تقييم المعلم مباشرة، وليست تقييمًا آليًا.</p>
        </section>
        {!!f.voice && (
          <div style={{ ...card, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={voice.toggle} aria-label="تشغيل الملاحظة الصوتية" style={{ width: 44, height: 44, borderRadius: '50%', border: 'none', background: color.sage, color: color.primary, display: 'grid', placeItems: 'center', cursor: 'pointer' }}><Icon name={voice.playing ? 'pause' : 'play'} /></button>
            <span style={{ flex: 1, fontSize: 14, fontWeight: 700 }}>ملاحظة صوتية من المعلم</span>
            <span dir="ltr" style={{ fontFamily: font.latin, fontSize: 13, color: color.muted }}>{voice.posL} / {voice.durL}</span>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <p style={muted(14, { fontWeight: 700 })}>ملاحظة عامة</p>
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.8, textWrap: 'pretty' }}>{f.general}</p>
        </div>
        <div style={{ background: color.goldTint, borderRadius: 16, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: color.warnInk }}>يحتاج مراجعة: <span style={{ color: color.ink }}>{f.needs}</span></p>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: color.primary }}>الإجراء التالي: <span style={{ color: color.ink, fontWeight: 500 }}>{f.next}</span></p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => go('record', { task: t.id })} style={outlineBtn(52, 15, { flex: 1 })}>سجّل مرة أخرى</button>
          <button onClick={() => tab('plan')} style={primaryBtn(52, 15, { flex: 1 })}>العودة إلى تعلمي</button>
        </div>
      </div>
    </div>
  );
}

function FbNote({ t, text, pkey, dur, url }: { t: number; text: string; pkey: string; dur: number; url?: string | null }) {
  const pl = usePlayer(pkey, dur, url);
  return (
    <button onClick={() => pl.seekTo(t)} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', textAlign: 'right', border: 'none', background: color.ivory, borderRadius: 12, padding: '10px 12px', cursor: 'pointer', minHeight: 48, color: color.ink }}>
      <span dir="ltr" style={{ fontFamily: font.latin, fontSize: 13, fontWeight: 700, color: color.goldInk, background: color.goldChip, borderRadius: 8, padding: '3px 8px', flexShrink: 0 }}>{fmt(t)}</span>
      <span style={{ fontSize: 14, lineHeight: 1.7 }}>{text}</span>
    </button>
  );
}
