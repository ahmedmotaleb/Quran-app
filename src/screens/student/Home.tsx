import { color } from '@/theme/tokens';
import { Icon, type IconName } from '@/components/Icon';
import { Badge, ProgressBar, card, iconTile, muted, primaryBtn } from '@/components/ui';
import { TODAY_LABEL } from '@/data/demo';
import { dateKey, fmtDay } from '@/lib/time';
import { rangeL, tzOf } from '@/lib/format';
import { go, setState, tab, toast, useApp } from '@/store/store';
import { homeHifz, upcomingSessions } from '@/store/selectors';
import { BRAND } from '@/theme/brand';
import { useEffect, useState } from 'react';
import { api } from '@/api/client';
import { InboxBell } from '@/screens/common/Inbox';

interface PlanItem { priority: number; kind: string; title: string; ref: number; due: string | null; state: 'todo' | 'done'; reason: string; est_minutes: number | null; subtitle: string }
interface Plan { date: string; items: PlanItem[]; counts: { todo: number; done: number; overdue: number }; est_minutes: number | null; rules: string[] }
const KIND: Record<string, [string, IconName]> = { hifz: ['حفظ', 'book'], review: ['مراجعة', 'repeat'], tajweed: ['تجويد', 'mic'], session: ['جلسة', 'video'], lesson: ['درس', 'layers'], quiz: ['اختبار', 'plan'] };

/** خطة اليوم from the server (pack prompt 16): deterministic order, completed items stay visible once. Offline shows the
 * last plan the app loaded, marked as such — nothing is claimed as saved while offline. */
function TodayPlanLive() {
  const tasks = useApp((x) => x.tasks); const subs = useApp((x) => x.subs);
  const [p, setP] = useState<Plan | null>(null); const [stale, setStale] = useState(false); const [why, setWhy] = useState(false);
  useEffect(() => {
    let on = true;
    api<Plan>('GET', 'today').then((x) => { if (!on) return; setP(x); setStale(false); try { localStorage.setItem('halqa.today', JSON.stringify(x)); } catch { /* optional */ } })
      .catch(() => { if (!on) return; try { const c = localStorage.getItem('halqa.today'); if (c) { setP(JSON.parse(c)); setStale(true); } } catch { /* none */ } });
    return () => { on = false; };
  }, [tasks.length, subs.length, tasks.map((t) => t.status).join()]);
  if (!p) return null;
  const open = (i: PlanItem) => {
    if (i.kind === 'session') tab('circles');
    else if (i.kind === 'lesson') go('lesson', { id: String(i.ref) });
    else if (i.kind === 'quiz') tab('circles');
    else go('task', { id: String(i.ref) });
  };
  return (
    <section aria-labelledby="today-h" style={{ ...card, borderRadius: 20, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <h2 id="today-h" style={{ margin: 0, fontSize: 17, fontWeight: 800, flex: 1 }}>خطة اليوم</h2>
        <span style={{ fontSize: 13, color: color.muted }}>{p.counts.todo ? `${p.counts.todo} متبقية` : 'أنجزت خطة اليوم'}{p.counts.done ? ` · ${p.counts.done} منجزة` : ''}{p.est_minutes ? ` · نحو ${p.est_minutes} دقيقة` : ''}</span>
      </div>
      {stale && <p role="status" style={muted(12)}>غير متصل: هذه آخر خطة محمّلة وقد لا تكون محدّثة.</p>}
      {p.items.length === 0 && <p style={muted(14)}>لا شيء مستحق اليوم. يمكنك مراجعة ما حفظته أو قراءة درس.</p>}
      {p.items.map((i) => {
        const [label, icon] = KIND[i.kind] ?? ['', 'check'];
        const done = i.state === 'done';
        return (
          <button key={`${i.kind}-${i.ref}-${i.state}`} onClick={() => open(i)} style={{ minHeight: 56, padding: '8px 10px', borderRadius: 14, border: `1px solid ${i.priority === 1 && !done ? color.danger : color.divider}`, background: done ? color.sand : color.card, display: 'flex', alignItems: 'center', gap: 10, textAlign: 'right', cursor: 'pointer', color: color.ink, opacity: done ? 0.8 : 1 }}>
            <span style={iconTile(36, done ? color.track : color.sage, color.primary, 10)}><Icon name={done ? 'check' : icon} size={18} /></span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 15, fontWeight: 700, textDecoration: done ? 'line-through' : 'none' }}>{i.title}</span>
              <span style={{ display: 'block', fontSize: 12, color: i.priority === 1 && !done ? color.danger : color.muted }}>{label} · {i.reason}{i.subtitle ? ` · ${i.subtitle}` : ''}{i.est_minutes ? ` · ${i.est_minutes} د` : ''}</span>
            </span>
            <Icon name="chevL" size={18} />
          </button>
        );
      })}
      <button onClick={() => setWhy(!why)} aria-expanded={why} style={{ alignSelf: 'flex-start', minHeight: 40, border: 'none', background: 'transparent', color: color.primary, textDecoration: 'underline', cursor: 'pointer', fontSize: 13 }}>كيف تُرتّب الخطة؟</button>
      {why && <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12, lineHeight: 1.8, color: color.body }}>{p.rules.map((r) => <li key={r}>{r}</li>)}</ul>}
    </section>
  );
}

const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,320px),1fr))', gap: 16 } as const;

export function bookSession() { tab('circles'); setState({ circTab: 'teachers' }); }

export default function Home() {
  const s = useApp();
  const next = upcomingSessions(s)[0];
  const hifz = homeHifz(s);
  const rev = s.tasks.find((t) => t.today && t.type === 'review');
  const newFb = s.tasks.find((t) => t.status === 'reviewed' && s.fb[t.id]?.date.startsWith('اليوم'));

  const hifzAction = hifz && (hifz.status === 'submitted' ? 'عرض التسليم' : hifz.status === 'reviewed' ? 'عرض التقييم' : 'سجّل تلاوتك');
  const hifzGo = () => hifz && (hifz.status === 'reviewed' ? go('feedback', { id: hifz.id }) : hifz.status === 'submitted' ? go('task', { id: hifz.id }) : go('record', { task: hifz.id }));
  const quick: { label: string; icon: IconName; click: () => void }[] = [
    { label: 'افتح المصحف', icon: 'book', click: () => go('mushaf', {}) },
    { label: 'سجّل تلاوتك', icon: 'mic', click: () => go('record', { task: hifz ? hifz.id : 'k1' }) },
    { label: 'احجز جلسة', icon: 'cal', click: bookSession },
  ];

  return (
    <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 16, position: 'relative' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 56 }}>
        <img src="/assets/halqa-mark.png" alt={BRAND.ar} style={{ width: 38, height: 38, objectFit: 'contain' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 21, fontWeight: 800 }}>السلام عليكم، {s.user.first}</h1>
          <p style={muted(13)}>{s.liveMode ? fmtDay(new Date().toISOString(), tzOf(s.tz).iana) : TODAY_LABEL}</p>
        </div>
        {s.liveMode ? <InboxBell /> : <button onClick={() => toast('لا توجد إشعارات جديدة', 'bell')} aria-label="الإشعارات"
          style={{ width: 48, height: 48, borderRadius: 14, border: `1px solid ${color.border}`, background: color.card, color: color.primary, display: 'grid', placeItems: 'center', cursor: 'pointer' }}>
          <Icon name="bell" />
        </button>}
      </header>

      {newFb && (
        <button onClick={() => go('feedback', { id: newFb.id })} style={{ minHeight: 56, padding: '10px 14px', borderRadius: 14, border: `1.5px solid ${color.gold}`, background: color.goldTint, display: 'flex', alignItems: 'center', gap: 10, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
          <span style={{ color: color.goldInk }}><Icon name="award" /></span>
          <span style={{ flex: 1, fontSize: 15 }}><strong>وصل تقييم معلمك</strong> · {newFb.title}</span>
          <span style={{ color: color.primary }}><Icon name="chevL" /></span>
        </button>
      )}

      {s.liveMode && <TodayPlanLive />}
      <div style={grid}>
        {next ? (
          <section aria-label="الجلسة القادمة" style={{ background: color.primary, color: color.ivory, borderRadius: 20, padding: 18, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ position: 'absolute', width: 220, height: 220, borderRadius: '50%', border: '26px solid rgba(216,229,215,.08)', left: -100, top: -120 }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, position: 'relative' }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: color.sage }}>الجلسة القادمة</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 999, background: 'rgba(247,243,232,.14)', fontSize: 13, fontWeight: 700 }}><Icon name="check" size={18} /> مؤكدة</span>
            </div>
            <p style={{ margin: '10px 0 2px', fontSize: 19, fontWeight: 700, position: 'relative' }}>{next.teacherName}</p>
            <p style={{ margin: 0, fontSize: 15, color: '#E5EDE4', position: 'relative' }}>{next.when} · {next.dur} دقيقة</p>
            <p style={{ margin: '2px 0 14px', fontSize: 13, color: color.liveSub, position: 'relative' }}>{next.tzL}</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 'auto', position: 'relative' }}>
              {next.isToday && (
                <button onClick={() => go('live', { id: next.id })} style={primaryBtn(52, 16, { flex: 1, background: color.ivory, color: color.primary, fontWeight: 800 })}>
                  <Icon name="video" /> ادخل غرفة الانتظار
                </button>
              )}
              <button onClick={() => go('session', { id: next.id })} aria-label="تفاصيل الجلسة"
                style={{ minHeight: 52, padding: '0 16px', borderRadius: 14, border: '1.5px solid rgba(247,243,232,.4)', background: 'transparent', color: color.ivory, fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>التفاصيل</button>
            </div>
          </section>
        ) : (
          <section style={{ background: color.card, border: `1px dashed ${color.borderStrong}`, borderRadius: 20, padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>لا توجد جلسة قادمة</p>
            <p style={muted(14)}>احجز جلسة مع معلمك لمتابعة خطتك.</p>
            <button onClick={bookSession} style={primaryBtn(48, 15)}>احجز جلسة</button>
          </section>
        )}

        {hifz && (
          <section aria-label="واجب الحفظ اليوم" style={{ ...card, borderRadius: 20, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: color.muted, display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="book" size={18} /> واجب الحفظ اليوم</span>
              <Badge kind={hifz.status} />
            </div>
            <button onClick={() => go('task', { id: hifz.id })} style={{ border: 'none', background: 'transparent', padding: 0, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
              <span style={{ display: 'block', fontSize: 22, fontWeight: 800 }}>{hifz.title}</span>
              <span style={{ display: 'block', fontSize: 15, color: color.body, marginTop: 4 }}>{rangeL(hifz)}</span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: color.muted, marginTop: 6 }}><Icon name="clock" size={18} /> التسليم: {hifz.due}</span>
            </button>
            <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
              <button onClick={hifzGo} style={primaryBtn(52, 16, { flex: 1 })}><Icon name="mic" /> {hifzAction}</button>
              <button onClick={() => go('mushaf', { s: hifz.s, from: hifz.from, to: hifz.to })} aria-label="افتح النطاق في المصحف"
                style={{ width: 52, minHeight: 52, border: 'none', borderRadius: 14, background: color.sage, color: color.primary, display: 'grid', placeItems: 'center', cursor: 'pointer' }}>
                <Icon name="book" />
              </button>
            </div>
          </section>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
        {quick.map((a) => (
          <button key={a.label} onClick={a.click} style={{ minHeight: 84, borderRadius: 16, border: `1px solid ${color.border}`, background: color.card, color: color.primary, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
            <span style={iconTile(40, color.sage, color.primary, 12)}><Icon name={a.icon} /></span>{a.label}
          </button>
        ))}
      </div>

      <div style={grid}>
        {rev && (
          <button onClick={() => go('task', { id: rev.id })} style={{ ...card, padding: 16, display: 'flex', alignItems: 'center', gap: 12, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
            <span style={iconTile(44, color.sand, color.primary, 12)}><Icon name="repeat" /></span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13, color: color.muted, fontWeight: 700 }}>المراجعة المستحقة اليوم</span>
              <span style={{ display: 'block', fontSize: 17, fontWeight: 700, marginTop: 2 }}>{rev.title}</span>
              <span style={{ display: 'block', fontSize: 13, color: color.muted, marginTop: 2 }}>{rangeL(rev)}</span>
            </span>
            <Badge kind={rev.status} size="sm" />
          </button>
        )}
        <button onClick={() => tab('progress')} style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 10, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
          <span style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: color.muted, fontWeight: 700 }}>تقدّمك</span>
            <span style={{ color: color.primary, fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 2 }}>التفاصيل <Icon name="chevL" size={18} /></span>
          </span>
          {s.liveMode ? <LiveSummary /> : <>
            <span style={{ fontSize: 16, fontWeight: 700 }}>حفظ معتمد: 3 سور · 18% من جزء تبارك</span>
            <ProgressBar pct={18} />
            <span style={{ fontSize: 13, color: color.muted }}>أتممت واجباتك 5 أيام هذا الأسبوع، استمر بهدوء.</span>
          </>}
        </button>
      </div>
    </div>
  );
}

/** Live: real counts only — approved memorisation tasks and days this week with a submitted recitation. */
function LiveSummary() {
  const s = useApp(); const tz = tzOf(s.tz).iana;
  const hifz = s.tasks.filter((t) => t.type === 'hifz');
  const ok = hifz.filter((t) => t.status === 'reviewed').length;
  const weekAgo = Date.now() - 7 * 86_400_000;
  const days = new Set(s.subs.filter((x) => new Date(x.created_at).getTime() >= weekAgo).map((x) => dateKey(x.created_at, tz))).size;
  return <>
    <span style={{ fontSize: 16, fontWeight: 700 }}>حفظ معتمد: {ok} من {hifz.length} مهام</span>
    <ProgressBar pct={hifz.length ? (ok / hifz.length) * 100 : 0} />
    <span style={{ fontSize: 13, color: color.muted }}>{days ? `سلّمت تلاوتك في ${days} ${days === 1 ? 'يوم' : days === 2 ? 'يومين' : 'أيام'} هذا الأسبوع، استمر بهدوء.` : 'لم تسلّم تلاوة هذا الأسبوع بعد. ابدأ بخطوة صغيرة.'}</span>
  </>;
}
