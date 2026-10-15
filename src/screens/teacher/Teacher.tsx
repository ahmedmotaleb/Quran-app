import { color, font } from '@/theme/tokens';
import { Icon, type IconName } from '@/components/Icon';
import {
  Avatar, BackHeader, Badge, Chips, FieldError, Ltr, PlayerBar, RecDot, SearchInput, Segmented, Switch, card, iconTile, inputStyle, labelStyle, muted, outlineBtn, primaryBtn, usePlayer,
} from '@/components/ui';
import { DAYS, SUR, TODAY_LABEL } from '@/data/demo';
import { fmt, scoreL, timeIn, typeIcon, tzLabel, tzOf } from '@/lib/format';
import { dateKey, dayLabel, fmtDay, fmtTime, zonedToIso as zonedIso } from '@/lib/time';
import { gradeRecitation, setAttendance, teacherCancelBooking, toggleSlot as toggleLiveSlot } from '@/store/live';
import type { ApiGradingItem } from '@/api/endpoints';
import { useState } from 'react';
import { weekDays } from '@/store/selectors';
import { openSheet } from '@/store/store';
import {
  go, openAssign, openReview, playerSeek, selectReviews, sendAssign, sendReview, setState, tab, toast, up, useApp, back,
  type AppState, type ReviewItem,
} from '@/store/store';
import { useEvals } from '@/screens/student/Progress';
import { BRAND } from '@/theme/brand';
import { useEffect } from 'react';
import { ProgressCards } from '@/components/ProgressCards';
import { InboxBell } from '@/screens/common/Inbox';
import { api } from '@/api/client';
import { studentProgress, type ApiProgress } from '@/api/endpoints';

interface Dash {
  awaiting_review: { submission: number; student: { id: number; name: string }; title: string; age_hours: number }[];
  overdue: { assignment: number; student: { id: number; name: string }; title: string; days_late: number }[];
  repeated_needs_repeat: { student: { id: number; name: string }; needs_repeat_30d: number }[];
  falling_scores: { student: { id: number; name: string }; recent_avg: number; previous_avg: number }[];
  rules: Record<string, string>;
}

/** Observable signals for the teacher's own students (dates and counts, no hidden scoring). Each item opens the
 * student's file, where the exact task or submission is. */
function AttentionLive() {
  const [d, setD] = useState<Dash | null>(null);
  useEffect(() => { let on = true; api<Dash>('GET', 'teacher/dashboard').then((x) => on && setD(x)).catch(() => {}); return () => { on = false; }; }, []);
  if (!d) return null;
  const items: { key: string; sid: number; name: string; text: string }[] = [
    ...d.overdue.map((x) => ({ key: `o${x.assignment}`, sid: x.student.id, name: x.student.name, text: `متأخرة ${x.days_late} يوم: ${x.title}` })),
    ...d.repeated_needs_repeat.map((x) => ({ key: `r${x.student.id}`, sid: x.student.id, name: x.student.name, text: `طلبتَ الإعادة ${x.needs_repeat_30d} مرات خلال 30 يومًا` })),
    ...d.falling_scores.map((x) => ({ key: `f${x.student.id}`, sid: x.student.id, name: x.student.name, text: `متوسط آخر التقييمات ${x.recent_avg} (كان ${x.previous_avg})` })),
  ];
  const oldest = d.awaiting_review[0];
  if (!items.length && !oldest) return null;
  return (
    <section style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }} aria-labelledby="att-h">
      <h2 id="att-h" style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>يحتاج انتباهك</h2>
      {oldest && <p style={muted(13)}>أقدم تسجيل ينتظر المراجعة منذ {oldest.age_hours < 24 ? `${Math.round(oldest.age_hours)} ساعة` : `${Math.round(oldest.age_hours / 24)} يوم`} ({oldest.student.name}).</p>}
      {items.slice(0, 8).map((x) => (
        <button key={x.key} onClick={() => go('tstudent', { id: String(x.sid) })} style={{ minHeight: 52, padding: '8px 12px', borderRadius: 12, border: `1px solid ${color.divider}`, background: color.ivory, textAlign: 'right', cursor: 'pointer', color: color.ink, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1 }}><span style={{ display: 'block', fontWeight: 700, fontSize: 14 }}>{x.name}</span><span style={{ display: 'block', fontSize: 12, color: color.body }}>{x.text}</span></span>
          <Icon name="chevL" size={18} />
        </button>
      ))}
    </section>
  );
}

interface Sched { id: number; surah_name: string; ayah_from: number; ayah_to: number; step: number; interval_days: number; next_due: string; active: boolean; cycles: number;
  history: { at: string; kind_label: string; due_on: string | null; outcome: string; reason: string; actor: string | null }[] }
const OUTCOME: Record<string, string> = { next: 'إلى الفاصل التالي', same: 'الفاصل نفسه', earlier: 'فاصل أقصر', repeat: 'إعادة' };

/** Spaced-repetition schedules of one student: next date, interval, history; override with a reason, pause/resume. */
function ReviewSchedulesLive({ id }: { id: number }) {
  const [d, setD] = useState<{ help: string; results: Sched[] } | null>(null);
  const [edit, setEdit] = useState<{ s: Sched; date: string; reason: string; err?: string } | null>(null); const [openH, setOpenH] = useState<number | null>(null);
  const load = () => api<{ help: string; results: Sched[] }>('GET', `teacher/students/${id}/review-schedules`).then(setD).catch(() => setD({ help: '', results: [] }));
  useEffect(() => { void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (body: Record<string, unknown>, sched: Sched) => {
    try { await api('PATCH', `teacher/review-schedules/${sched.id}`, body); toast('حُفظ التعديل'); setEdit(null); await load(); }
    catch (e) { const er = e as { message: string; field?: (n: string) => string | null }; setEdit(edit && { ...edit, err: er.field?.('reason') ?? er.field?.('next_due') ?? er.message }); if (!edit) toast(er.message, 'alert'); }
  };
  if (!d || !d.results.length) return null;
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>جدول المراجعة</h3>
      <details style={{ fontSize: 12, color: color.body }}><summary style={{ cursor: 'pointer', minHeight: 40, display: 'flex', alignItems: 'center' }}>كيف تُجدول المراجعات؟</summary><p style={{ margin: 0, lineHeight: 1.8 }}>{d.help}</p></details>
      {d.results.map((x) => (
        <div key={x.id} style={{ ...card, borderRadius: 14, padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ flex: 1, fontWeight: 700 }}>سورة {x.surah_name} {x.ayah_from}–{x.ayah_to}</span>
            <span style={{ fontSize: 12, color: x.active ? color.primary : color.muted }}>{x.active ? `التالية ${x.next_due} · كل ${x.interval_days} يوم` : 'موقوفة'}</span>
          </div>
          {edit?.s.id === x.id ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 13, fontWeight: 700 }}>الموعد الجديد<input type="date" dir="ltr" value={edit.date} onChange={(e) => setEdit({ ...edit, date: e.target.value })} style={{ display: 'block', marginTop: 4, minHeight: 44, borderRadius: 10, border: `1px solid ${color.borderInput}`, padding: '0 10px', width: '100%' }} /></label>
              <label style={{ fontSize: 13, fontWeight: 700 }}>السبب<input value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} style={{ display: 'block', marginTop: 4, minHeight: 44, borderRadius: 10, border: `1px solid ${color.borderInput}`, padding: '0 10px', width: '100%' }} /></label>
              {edit.err && <p role="alert" style={{ margin: 0, color: color.danger, fontSize: 13 }}>{edit.err}</p>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => save({ next_due: edit.date, reason: edit.reason }, x)} style={primaryBtn(44, 14, { padding: '0 14px' })}>حفظ</button>
                <button onClick={() => setEdit(null)} style={{ minHeight: 44, padding: '0 14px', borderRadius: 12, border: `1px solid ${color.borderStrong}`, background: color.card, color: color.primary, cursor: 'pointer' }}>إلغاء</button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={() => setEdit({ s: x, date: x.next_due, reason: '' })} style={{ minHeight: 40, padding: '0 12px', borderRadius: 10, border: `1px solid ${color.borderStrong}`, background: color.card, color: color.primary, cursor: 'pointer', fontWeight: 700 }}>تعديل الموعد</button>
              <button onClick={() => { const r = window.prompt(x.active ? 'سبب إيقاف المراجعات:' : 'سبب الاستئناف:'); if (r) void save({ active: !x.active, reason: r }, x); }} style={{ minHeight: 40, padding: '0 12px', borderRadius: 10, border: `1px solid ${color.borderStrong}`, background: color.card, color: color.primary, cursor: 'pointer', fontWeight: 700 }}>{x.active ? 'إيقاف' : 'استئناف'}</button>
              <button onClick={() => setOpenH(openH === x.id ? null : x.id)} aria-expanded={openH === x.id} style={{ minHeight: 40, padding: '0 12px', borderRadius: 10, border: 'none', background: 'transparent', color: color.primary, cursor: 'pointer', textDecoration: 'underline' }}>السجل ({x.history.length})</button>
            </div>
          )}
          {openH === x.id && <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12, lineHeight: 1.8, color: color.body }}>
            {x.history.map((h, i) => <li key={i}>{h.at.slice(0, 10)} · {h.kind_label}{h.outcome ? ` (${OUTCOME[h.outcome] ?? h.outcome})` : ''}{h.due_on ? ` · الموعد ${h.due_on}` : ''}{h.reason ? ` · ${h.reason}` : ''}{h.actor ? ` · ${h.actor}` : ''}</li>)}
          </ul>}
        </div>
      ))}
    </section>
  );
}

function StudentProgressLive({ id }: { id: number }) {
  const [p, setP] = useState<ApiProgress | null>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { let on = true; studentProgress(id).then((x) => on && setP(x)).catch((e) => on && setErr((e as Error).message)); return () => { on = false; }; }, [id]);
  if (err) return <p role="alert" style={muted(13)}>تعذّر تحميل التقدّم: {err}</p>;
  if (!p) return <p role="status" style={muted(13)}>جارٍ تحميل التقدّم…</p>;
  return <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}><h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>التقدّم (آخر 30 يومًا)</h3><ProgressCards p={p} who="teacher" /></section>;
}

function useReviews() {
  const s = useApp();
  const revs = selectReviews(s);
  const open = (r: ReviewItem) => (r.status === 'submitted' ? openReview(r.id) : toast('أُرسل تقييم هذا التسجيل'));
  return { revs, pend: revs.filter((r) => r.status === 'submitted'), open };
}

/* ---------------- Today dashboard ---------------- */
const TODAY_SESSIONS = [
  { h: 16, stu: 'عمر الحربي', type: 'فردية · 45 دقيقة', task: 'حفظ سورة الفجر 1–14' },
  { h: 17, stu: 'يوسف أحمد', type: 'فردية · 45 دقيقة', task: 'حفظ سورة الملك 1–10', sid: 's1' },
  { h: 20, stu: 'حلقة المراجعة المسائية', type: 'جماعية · 6 طلاب', task: 'مراجعة جزء عمّ' },
];

export function TeacherDash() {
  const tz = useApp((s) => s.tz); const live = useApp((s) => s.liveMode); const name = useApp((s) => s.user.name);
  const { pend, open } = useReviews();
  const tiles: { label: string; icon: IconName; click: () => void }[] = [
    { label: 'أنشئ واجبًا', icon: 'plus', click: () => openAssign(live ? undefined : 'u1') },
    { label: 'محاضرة أو اختبار', icon: 'layers', click: () => go('tcontent') },
    { label: 'المواعيد', icon: 'cal', click: () => tab('tschedule') },
  ];
  return (
    <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 56 }}>
        <img src="/assets/halqa-mark.png" alt={BRAND.ar} style={{ width: 38, height: 38, objectFit: 'contain' }} />
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 21, fontWeight: 800 }}>مرحبًا، {live ? name : 'الشيخ عبدالرحمن'}</h1>
          <p style={muted(13)}>{live ? fmtDay(new Date().toISOString(), tzOf(tz).iana) : TODAY_LABEL.replace(' 2026', '')} · {tzLabel(tz)}</p>
        </div>
        {live && <InboxBell />}
      </header>
      <section style={{ background: color.primary, color: color.ivory, borderRadius: 20, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>تسجيلات تنتظر المراجعة</h2>
          <span style={{ fontFamily: font.latin, fontSize: 22, fontWeight: 700 }}>{pend.length}</span>
        </div>
        {pend.length === 0 && <p style={{ margin: 0, fontSize: 14, color: color.sage }}>لا توجد تسجيلات تنتظر المراجعة.</p>}
        {pend.slice(0, 3).map((r) => (
          <button key={r.id} onClick={() => open(r)} style={{ minHeight: 60, padding: '10px 12px', borderRadius: 14, border: 'none', background: 'rgba(247,243,232,.1)', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'right', cursor: 'pointer', color: color.ivory }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{r.student} · {r.title}</span>
              <span style={{ display: 'block', fontSize: 12, color: color.liveSub, marginTop: 2 }}>{r.at} · <Ltr>{fmt(r.dur)}</Ltr></span>
            </span>
            <span style={{ minHeight: 36, padding: '0 12px', borderRadius: 10, background: color.ivory, color: color.primary, fontSize: 13, fontWeight: 800, display: 'flex', alignItems: 'center' }}>راجِع</span>
          </button>
        ))}
        {pend.length > 0 && <button onClick={() => tab('treviews')} style={{ minHeight: 44, border: 'none', background: 'transparent', color: color.ivory, fontSize: 14, fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}>عرض كل المراجعات</button>}
      </section>
      {live && <AttentionLive />}
      {live && <TodayLive />}
      {!live && <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>جلسات اليوم</h2>
        {TODAY_SESSIONS.map((x, i) => (
          <div key={x.stu} style={{ ...card, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ minWidth: 64, textAlign: 'center', fontSize: 16, fontWeight: 800 }}>{timeIn(tz, x.h)}</span>
            <span style={{ flex: 1, minWidth: 0, borderRight: `1px solid ${color.divider}`, paddingRight: 12 }}>
              <span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{x.stu}</span>
              <span style={{ display: 'block', fontSize: 12, color: color.muted, marginTop: 2 }}>{x.type} · {x.task}</span>
            </span>
            {i === 0 && <button onClick={() => go('live', { id: x.sid || 's1' })} style={primaryBtn(44, 14, { padding: '0 14px', borderRadius: 12 })}>ابدأ</button>}
          </div>
        ))}
      </section>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
        {tiles.map((t) => (
          <button key={t.label} onClick={t.click} style={{ minHeight: 84, borderRadius: 16, border: `1px solid ${color.border}`, background: color.card, color: color.primary, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
            <span style={iconTile(40, color.sage, color.primary, 12)}><Icon name={t.icon} /></span>{t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Students list + profile ---------------- */
export function TeacherStudents() {
  const s = useApp(); const { pend } = useReviews();
  const subIds = pend.map((r) => r.sid); const sq = s.stuQ.trim();
  const list = s.students.filter((u) => (!sq || u.name.includes(sq)) && (s.stuF === 'all' || (s.stuF === 'sub' && subIds.includes(u.id)) || (s.stuF === 'late' && u.late) || u.level === s.stuF));
  return (
    <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1 style={{ margin: '12px 0 0', fontSize: 24, fontWeight: 800 }}>الطلاب</h1>
      <SearchInput value={s.stuQ} onChange={(v) => setState({ stuQ: v })} placeholder="ابحث باسم الطالب" />
      <Chips scroll options={[['all', 'الكل'], ['sub', 'لديه تسليم'], ['late', 'متأخر'], ['مبتدئ', 'مبتدئ'], ['متوسط', 'متوسط'], ['متقدم', 'متقدم']] as const} value={s.stuF} onChange={(k) => setState({ stuF: k })} wrapStyle={{ paddingBottom: 0 }} />
      <p style={muted(13)}>{list.length} من {s.students.length} طالب</p>
      {list.length === 0 && (
        <div style={{ textAlign: 'center', padding: 20, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
          <p style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>لا يوجد طلاب مطابقون</p>
          <button onClick={() => setState({ stuQ: '', stuF: 'all' })} style={outlineBtn(44, 15, { padding: '0 16px', borderRadius: 12 })}>مسح التصفية</button>
        </div>
      )}
      {list.map((u) => {
        const b = subIds.includes(u.id) ? 'newsub' : u.late ? 'late' : null;
        return (
          <button key={u.id} onClick={() => go('tstudent', { id: u.id })} style={{ ...card, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'right', cursor: 'pointer', color: color.ink, minHeight: 68 }}>
            <Avatar ini={u.ini} size={44} fs={18} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{u.name}</span>
              <span style={{ display: 'block', fontSize: 12, color: color.muted, marginTop: 2 }}>{u.level} · {u.plan}</span>
            </span>
            {b && <Badge kind={b} size="sm" />}
          </button>
        );
      })}
    </div>
  );
}

export function TeacherStudent() {
  const s = useApp(); const { revs, open } = useReviews(); const evals = useEvals();
  // Never fall back to another student's file in live mode (e.g. while the list is still loading).
  const u = s.students.find((x) => x.id === s.params.id) || (s.liveMode ? undefined : s.students[0]);
  if (!u) return <div><BackHeader title="ملف الطالب" sticky /><p role="status" style={muted(14, { padding: 16 })}>{s.liveMode && !s.students.length ? 'جارٍ التحميل…' : 'هذا الطالب غير مرتبط بك.'}</p></div>;
  const live = s.liveMode;
  const isY = live || u.id === 'u1';
  const recs = revs.filter((r) => r.sid === u.id);
  const tasks = isY
    ? s.tasks.filter((t) => t.status !== 'reviewed' && (!live || t.sid === u.id)).map((t) => ({ id: t.id, title: t.title, range: `سورة ${SUR[t.s]?.[0] ?? ''} · الآيات ${t.from}–${t.to}`, kind: t.status, icon: typeIcon(t.type),
      open: () => { const r = revs.find((rr) => rr.taskId === t.id && rr.status === 'submitted'); if (r) open(r); else toast('لا يوجد تسليم لهذه المهمة بعد', 'clock'); } }))
    : [{ id: 'x', title: u.plan, range: 'الواجب الحالي', kind: 'in_progress' as const, icon: 'book' as IconName, open: () => toast('بيانات عرض مختصرة لهذا الطالب', 'clock') }];

  return (
    <div>
      <BackHeader title="ملف الطالب" sticky />
      <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <Avatar ini={u.ini} size={64} fs={26} />
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>{u.name}</h2>
            <p style={{ margin: '3px 0 0', fontSize: 14, color: color.body }}>{u.age ? `${u.age} سنة · ` : ''}المستوى {u.level}</p>
            <p style={muted(12, { margin: '2px 0 0' })}>ولي الأمر: {live ? (u.guardian ? 'مرتبط' : 'غير مرتبط') : isY || u.id === 'u2' ? 'أحمد العلي (مرتبط)' : 'غير مرتبط'}</p>
          </div>
        </div>
        {!live && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div style={{ ...card, borderRadius: 14, padding: 12 }}><p style={muted(12)}>الحضور</p><p style={{ margin: '4px 0 0', fontSize: 18, fontWeight: 800 }}>{u.att}</p></div>
          <div style={{ ...card, borderRadius: 14, padding: 12 }}><p style={muted(12)}>الخطة الحالية</p><p style={{ margin: '4px 0 0', fontSize: 15, fontWeight: 700 }}>{u.plan}</p></div>
        </div>}
        {live && <StudentProgressLive key={u.id} id={Number(u.id)} />}
        {live && <ReviewSchedulesLive key={`r${u.id}`} id={Number(u.id)} />}
        <button onClick={() => openAssign(u.id)} style={primaryBtn(52, 16)}><Icon name="plus" /> أنشئ واجبًا لـ {u.name}</button>
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>الخطة</h3>
          {tasks.length === 0 && <p style={muted(14)}>لا توجد مهام مفتوحة.</p>}
          {tasks.map((t) => (
            <button key={t.id} onClick={t.open} style={{ ...card, borderRadius: 14, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
              <span style={{ color: color.primary }}><Icon name={t.icon} /></span>
              <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{t.title}</span><span style={{ display: 'block', fontSize: 12, color: color.muted }}>{t.range}</span></span>
              <Badge kind={t.kind} size="sm" />
            </button>
          ))}
        </section>
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>التسجيلات</h3>
          {recs.length === 0 && <p style={muted(14)}>لا توجد تسجيلات حديثة.</p>}
          {recs.map((r) => (
            <button key={r.id} onClick={() => open(r)} style={{ ...card, borderRadius: 14, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
              <span style={{ flex: 1 }}><span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{r.title}</span><span style={{ display: 'block', fontSize: 12, color: color.muted }}>{r.at} · <Ltr>{fmt(r.dur)}</Ltr></span></span>
              <Badge kind={r.status === 'submitted' ? 'newsub' : 'reviewed'} size="sm" />
            </button>
          ))}
        </section>
        {isY && !live && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>التقييمات</h3>
            {evals.map((e) => (
              <div key={e.id} style={{ ...card, borderRadius: 14, padding: '12px 14px' }}>
                <p style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{e.t}</p>
                <p style={muted(12, { margin: '2px 0 0' })}>{e.d} · {e.sc}</p>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

/* ---------------- Create assignment ---------------- */
export function TeacherAssign() {
  const f = useApp((s) => s.af); const tz = useApp((s) => s.tz); const students = useApp((s) => s.students);
  if (!f) return <BackHeader title="واجب جديد" sticky />;
  const max = SUR[+f.s][1];
  const stu = students.find((x) => x.id === f.sid);
  const sel = { ...inputStyle(false), padding: '0 14px' };
  return (
    <div>
      <BackHeader title="واجب جديد" sticky />
      <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="af-stu" style={labelStyle}>الطالب</label>
          <select id="af-stu" value={f.sid} onChange={(e) => up('af', { sid: e.target.value })} style={sel}>
            {students.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={labelStyle}>نوع الواجب</span>
          <Segmented role="group" label="نوع الواجب" options={[['hifz', 'حفظ'], ['review', 'مراجعة'], ['tajweed', 'تجويد']] as const} value={f.type} onChange={(k) => up('af', { type: k })} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="af-s" style={labelStyle}>السورة</label>
          <select id="af-s" value={f.s} onChange={(e) => up('af', { s: e.target.value, errors: {} })} style={sel}>
            {Object.keys(SUR).map((k) => <option key={k} value={k}>{SUR[+k][0]} ({SUR[+k][1]} آية)</option>)}
          </select>
          <p style={muted(12)}>عدد آيات السورة: {max}</p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {([['af-from', 'من الآية', 'from'], ['af-to', 'إلى الآية', 'to']] as const).map(([id, l, k]) => (
            <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label htmlFor={id} style={labelStyle}>{l}</label>
              <input id={id} type="number" inputMode="numeric" min={1} max={max} dir="ltr" value={f[k]} aria-invalid={!!f.errors[k]}
                onChange={(e) => up('af', { [k]: e.target.value, errors: { ...f.errors, [k]: null } })} style={inputStyle(f.errors[k], false, { fontFamily: font.latin, textAlign: 'center' })} />
              <FieldError msg={f.errors[k]} fs={12} />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={labelStyle}>موعد التسليم</span>
          <Chips h={44} options={[['today', 'اليوم'], ['tomorrow', 'غدًا'], ['in3', 'بعد 3 أيام'], ['week', 'بعد أسبوع']] as const} value={f.due} onChange={(k) => up('af', { due: k })} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label htmlFor="af-time" style={{ fontSize: 14 }}>الساعة</label>
            <input id="af-time" type="time" dir="ltr" value={f.time} onChange={(e) => up('af', { time: e.target.value })} style={{ minHeight: 48, padding: '0 12px', borderRadius: 12, border: `1.5px solid ${color.borderInput}`, background: color.card, fontFamily: font.latin, fontSize: 15 }} />
            <span style={muted(12)}>{tzLabel(tz)}</span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="af-instr" style={labelStyle}>توجيهات للطالب</label>
          <textarea id="af-instr" rows={4} value={f.instr} onChange={(e) => up('af', { instr: e.target.value })} placeholder="مثال: استمع للتلاوة 3 مرات قبل الحفظ"
            style={{ width: '100%', padding: '12px 14px', borderRadius: 12, border: `1.5px solid ${color.borderInput}`, background: color.card, fontSize: 15, color: color.ink, resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 52 }}>
          <span style={{ fontSize: 15 }}>يتطلب تسجيل تلاوة</span>
          <Switch on={f.needRec} label="يتطلب تسجيل تلاوة" onToggle={() => up('af', { needRec: !f.needRec })} />
        </div>
        <button onClick={sendAssign} style={primaryBtn()}>إرسال الواجب إلى {stu?.name ?? 'الطالب'}</button>
      </div>
    </div>
  );
}

/* ---------------- Reviews list + review a recording ---------------- */
export function TeacherReviews() {
  const rvTab = useApp((s) => s.rvTab); const { revs, pend, open } = useReviews();
  const live = useApp((s) => s.liveMode); const grading = useApp((s) => s.grading);
  const list = revs.filter((r) => (rvTab === 'pending' ? r.status === 'submitted' : r.status === 'reviewed'));
  return (
    <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1 style={{ margin: '12px 0 0', fontSize: 24, fontWeight: 800 }}>المراجعات</h1>
      <Segmented role="tablist" fs={14} options={[['pending', `تنتظر المراجعة (${pend.length})`], ['done', 'تمت مراجعتها']] as const} value={rvTab} onChange={(k) => setState({ rvTab: k })} />
      {list.length === 0 && <p style={muted(15, { padding: 24, textAlign: 'center' })}>لا توجد تسجيلات تنتظر المراجعة</p>}
      {rvTab === 'pending' && live && !!grading?.length && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>أسئلة تلاوة في الاختبارات ({grading.length})</h2>
          {grading.map((g) => <GradeCard key={g.answer} g={g} />)}
        </section>
      )}
      {list.map((r) => (
        <button key={r.id} onClick={() => open(r)} style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 6, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
          <span style={{ display: 'flex', justifyContent: 'space-between', width: '100%', gap: 8 }}>
            <span style={{ fontSize: 16, fontWeight: 700 }}>{r.student}</span>
            <Badge kind={r.status === 'submitted' ? 'newsub' : 'reviewed'} size="sm" />
          </span>
          <span style={{ fontSize: 14 }}>{r.title} · {r.range}</span>
          <span style={{ fontSize: 12, color: color.muted }}>{r.at} · المدة <Ltr>{fmt(r.dur)}</Ltr></span>
        </button>
      ))}
    </div>
  );
}

export function TeacherReview() {
  const s = useApp(); const V = s.rv;
  const revs = selectReviews(s);
  const r = (V && revs.find((x) => x.id === V.rid)) || revs[0];
  const pl = usePlayer('rv', r?.dur ?? 0, r?.url);
  const voicePl = usePlayer('rvvoice', V?.voice || 0, null);
  if (!V || !r) return <BackHeader title="مراجعة التسجيل" sticky />;
  const curPos = s.player.key === 'rv' ? s.player.pos : 0;
  const notes = [...V.notes].sort((a, b) => a.t - b.t);
  const voiceL = fmt(V.voiceRec ? V.voiceSecs : V.voice || 0);

  return (
    <div>
      <BackHeader title="مراجعة التسجيل" sticky />
      <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <p style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{r.student}</p>
          <p style={{ margin: '3px 0 0', fontSize: 14, color: color.body }}>{r.title} · {r.range}</p>
          <p style={muted(12, { margin: '2px 0 0' })}>سُلّم {r.at}</p>
        </div>
        <section style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <PlayerBar k="rv" dur={r.dur} url={r.url} notes={V.notes} btnSize={52} />
          {V.draft === null ? (
            <button onClick={() => { if (pl.playing) pl.toggle(); up('rv', { draft: '', draftAt: curPos }); }}
              style={{ minHeight: 48, borderRadius: 12, border: `1.5px dashed ${color.gold}`, background: color.goldTint, color: color.warnInk, fontSize: 15, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, cursor: 'pointer' }}>
              <Icon name="plus" size={18} /> أضف ملاحظة عند <Ltr>{fmt(curPos)}</Ltr>
            </button>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, background: color.goldTint, borderRadius: 12, padding: 10 }}>
              <label htmlFor="rv-draft" style={{ fontSize: 13, fontWeight: 700, color: color.warnInk }}>ملاحظة عند <Ltr>{fmt(V.draftAt ?? 0)}</Ltr></label>
              <textarea id="rv-draft" rows={2} autoFocus value={V.draft} onChange={(e) => up('rv', { draft: e.target.value })} placeholder="مثال: انتبه لمدّ المنفصل هنا"
                style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${color.borderInput}`, background: color.card, fontSize: 15, resize: 'vertical' }} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => (V.draft!.trim() ? up('rv', { notes: [...V.notes, { t: V.draftAt ?? 0, text: V.draft!.trim() }], draft: null }) : up('rv', { draft: null }))}
                  style={primaryBtn(44, 15, { flex: 1, borderRadius: 10 })}>حفظ الملاحظة</button>
                <button onClick={() => up('rv', { draft: null })} style={{ minHeight: 44, padding: '0 14px', borderRadius: 10, border: `1px solid ${color.borderStrong}`, background: 'transparent', color: color.primary, fontWeight: 700, cursor: 'pointer' }}>إلغاء</button>
              </div>
            </div>
          )}
          {notes.map((n) => (
            <div key={`${n.t}-${n.text}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: color.ivory, borderRadius: 12, padding: '6px 6px 6px 4px' }}>
              <button onClick={() => playerSeek('rv', r.dur, n.t)} aria-label="انتقل إلى التوقيت" dir="ltr"
                style={{ minHeight: 40, border: 'none', background: color.goldChip, borderRadius: 8, padding: '0 8px', fontFamily: font.latin, fontSize: 13, fontWeight: 700, color: color.goldInk, cursor: 'pointer' }}>{fmt(n.t)}</button>
              <span style={{ flex: 1, fontSize: 14, lineHeight: 1.7, paddingTop: 8 }}>{n.text}</span>
              <button onClick={() => up('rv', { notes: V.notes.filter((x) => x !== n) })} aria-label="حذف الملاحظة" style={{ width: 40, height: 40, border: 'none', background: 'transparent', color: color.dangerInk, display: 'grid', placeItems: 'center', cursor: 'pointer' }}><Icon name="trash" size={18} /></button>
            </div>
          ))}
        </section>
        <section style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>التقييم</h2>
          {([['hifz', 'الحفظ'], ['tajweed', 'التجويد'], ['fluency', 'الطلاقة']] as const).map(([k, l]) => {
            const val = V.ratings[k]; const err = V.errors[k];
            return (
              <div key={k} role="radiogroup" aria-label={l} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ fontSize: 15, fontWeight: 700 }}>{l}</span><span style={muted(13)}>{val ? scoreL(val) : 'لم يُحدَّد'}</span></div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[1, 2, 3, 4, 5].map((n) => {
                    const on = val === n;
                    return <button key={n} role="radio" aria-checked={on} aria-label={`${l}: ${n} من 5 (${scoreL(n)})`} onClick={() => up('rv', { ratings: { ...V.ratings, [k]: n }, errors: { ...V.errors, [k]: null } })}
                      style={{ flex: 1, minHeight: 48, borderRadius: 12, border: `1.5px solid ${on ? color.primary : err ? color.danger : color.borderStrong}`, background: on ? color.primary : color.card, color: on ? color.ivory : color.primary, fontFamily: font.latin, fontSize: 16, fontWeight: 700, cursor: 'pointer' }}>{n}</button>;
                  })}
                </div>
                <FieldError msg={err} fs={12} />
              </div>
            );
          })}
        </section>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>القرار</span>
          <Segmented role="group" label="القرار" h={48} options={[['approve', 'اعتماد الحفظ'], ['redo', 'يحتاج إعادة']] as const} value={V.decision} onChange={(k) => up('rv', { decision: k, errors: { ...V.errors, needs: null } })} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="rv-needs" style={{ fontSize: 15, fontWeight: 700 }}>ما يحتاج مراجعة</label>
          <input id="rv-needs" value={V.needs} aria-invalid={!!V.errors.needs} onChange={(e) => up('rv', { needs: e.target.value, errors: { ...V.errors, needs: null } })} placeholder="مثال: الآيات 8–11" style={inputStyle(V.errors.needs, false, { fontSize: 15 })} />
          <FieldError msg={V.errors.needs} fs={12} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="rv-gen" style={{ fontSize: 15, fontWeight: 700 }}>ملاحظة عامة</label>
          <textarea id="rv-gen" rows={3} value={V.general} onChange={(e) => up('rv', { general: e.target.value })} style={{ width: '100%', padding: '12px 14px', borderRadius: 12, border: `1.5px solid ${color.borderInput}`, background: color.card, fontSize: 15, resize: 'vertical' }} />
        </div>
        {s.liveMode ? <p style={muted(12)}>الملاحظات الصوتية للمعلم لم تُفعَّل في التطبيق بعد؛ استخدم الملاحظات المكتوبة على التوقيت.</p> : <>
        <div style={{ ...card, borderRadius: 14, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10, minHeight: 64 }}>
          {!V.voiceRec && !V.voice && (
            <button onClick={() => up('rv', { voiceRec: true, voiceSecs: 0 })} style={{ flex: 1, minHeight: 44, border: 'none', background: 'transparent', color: color.primary, fontSize: 15, fontWeight: 700, display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}><Icon name="mic" /> سجّل ملاحظة صوتية (اختياري)</button>
          )}
          {V.voiceRec && (
            <>
              <RecDot /><span style={{ flex: 1, fontSize: 14, fontWeight: 700 }}>جارٍ تسجيل الملاحظة <Ltr>{voiceL}</Ltr></span>
              <button onClick={() => up('rv', { voiceRec: false, voice: Math.max(1, Math.round(V.voiceSecs)) })} style={primaryBtn(44, 15, { padding: '0 14px', borderRadius: 10 })}>إنهاء</button>
            </>
          )}
          {!!V.voice && !V.voiceRec && (
            <>
              <button onClick={voicePl.toggle} aria-label="تشغيل الملاحظة الصوتية" style={{ width: 44, height: 44, borderRadius: '50%', border: 'none', background: color.sage, color: color.primary, display: 'grid', placeItems: 'center', cursor: 'pointer' }}><Icon name={voicePl.playing ? 'pause' : 'play'} /></button>
              <span style={{ flex: 1, fontSize: 14, fontWeight: 700 }}>ملاحظة صوتية <Ltr>{voicePl.posL} / {voiceL}</Ltr></span>
              <button onClick={() => up('rv', { voice: null })} aria-label="حذف الملاحظة الصوتية" style={{ width: 44, height: 44, border: 'none', background: 'transparent', color: color.dangerInk, display: 'grid', placeItems: 'center', cursor: 'pointer' }}><Icon name="trash" size={18} /></button>
            </>
          )}
        </div>
        <p style={muted(12)}>الملاحظة الصوتية محاكاة داخل النموذج — لا يُلتقط صوت فعلي.</p>
        </>}
        <button onClick={sendReview} style={primaryBtn()}><Icon name="check" /> إرسال التقييم للطالب</button>
      </div>
    </div>
  );
}

/* ---------------- Schedule & availability ---------------- */
const BASE_HOURS = [16, 17, 18.5, 20, 21];
const SCHEDULE = [
  { d: 'اليوم', h: 16, stu: 'عمر الحربي', type: 'فردية' }, { d: 'اليوم', h: 17, stu: 'يوسف أحمد', type: 'فردية' },
  { d: 'اليوم', h: 20, stu: 'حلقة المراجعة المسائية', type: 'جماعية · 6 طلاب' }, { d: 'الإثنين 12 أكتوبر', h: 18.5, stu: 'ليان الشمري', type: 'فردية' },
  { d: 'الثلاثاء 13 أكتوبر', h: 17, stu: 'فيصل الدوسري', type: 'فردية' },
];

function toggleSlot(s: AppState, day: number, h: number) {
  const ex = s.avail.t1[day].find((x) => x.h === h);
  if (ex?.taken) { toast('لا يمكن إلغاء موعد محجوز من هنا؛ أعد جدولة الجلسة أولًا', 'alert'); return; }
  setState((st) => ({ avail: { ...st.avail, t1: st.avail.t1.map((d, i) => (i === day ? (ex ? d.filter((x) => x.h !== h) : [...d, { h, taken: false }].sort((a, b) => a.h - b.h)) : d)) } }));
}

export function TeacherSchedule() {
  const s = useApp(); const SD = s.sched;
  if (s.liveMode) return <ScheduleLive />;
  return (
    <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1 style={{ margin: '12px 0 0', fontSize: 24, fontWeight: 800 }}>المواعيد</h1>
      <Segmented role="tablist" options={[['sessions', 'الجلسات'], ['avail', 'الإتاحة']] as const} value={SD.tab} onChange={(k) => up('sched', { tab: k })} />
      {SD.tab === 'sessions' && SCHEDULE.map((x) => (
        <div key={x.d + x.h} style={{ ...card, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{x.d} · {timeIn(s.tz, x.h)}</span>
            <span style={{ display: 'block', fontSize: 13, color: color.muted, marginTop: 2 }}>{x.stu} · {x.type}</span>
          </span>
          <button onClick={() => toast(`أُرسل طلب إعادة جدولة إلى ${x.stu}`, 'cal')} style={{ minHeight: 44, padding: '0 12px', borderRadius: 10, border: `1px solid ${color.borderStrong}`, background: 'transparent', color: color.primary, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>إعادة جدولة</button>
        </div>
      ))}
      {SD.tab === 'avail' && (
        <>
          <p style={muted(13, { display: 'flex', gap: 6, alignItems: 'center' })}><Icon name="globe" size={18} /> تظهر للطلاب {tzLabel(s.tz)}، وتُحوَّل تلقائيًا لتوقيت كل طالب.</p>
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', margin: '0 -16px', padding: '2px 16px' }}>
            {DAYS.map((d, i) => {
              const on = SD.day === i;
              return (
                <button key={i} aria-pressed={on} onClick={() => up('sched', { day: i })} style={{ flexShrink: 0, width: 64, minHeight: 68, borderRadius: 14, border: `1.5px solid ${on ? color.primary : color.borderChip}`, background: on ? color.primary : color.card, color: on ? color.ivory : color.ink, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                  <span style={{ fontSize: 12, fontWeight: 700 }}>{i === 0 ? 'اليوم' : d[0]}</span>
                  <span style={{ fontFamily: font.latin, fontSize: 18, fontWeight: 700 }}>{d[1]}</span>
                </button>
              );
            })}
          </div>
          <div style={{ ...card, padding: '4px 14px' }}>
            {BASE_HOURS.map((h) => {
              const ex = s.avail.t1[SD.day].find((x) => x.h === h);
              const stt = ex ? (ex.taken ? 'محجوز' : 'متاح') : 'غير متاح';
              const label = timeIn(s.tz, h);
              return (
                <div key={h} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 56, borderBottom: `1px solid ${color.divider}` }}>
                  <span style={{ flex: 1, fontSize: 16, fontWeight: 700 }}>{label}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: ex?.taken ? color.warnInk : ex ? color.primary : color.muted }}>{stt}</span>
                  <Switch on={!!ex} label={`إتاحة ${label}`} onToggle={() => toggleSlot(s, SD.day, h)} />
                </div>
              );
            })}
          </div>
          <p style={muted(12)}>التغييرات تنعكس فورًا على صفحة الحجز لدى الطلاب داخل النموذج.</p>
        </>
      )}
    </div>
  );
}

/* ---------------- Create lecture / quiz ---------------- */
export function TeacherContent() {
  const TC = useApp((s) => s.tc);
  const sel = { minHeight: 52, padding: '0 10px', borderRadius: 12, border: `1.5px solid ${color.borderInput}`, background: color.card, fontSize: 15 } as const;
  const save = () => {
    const e: Record<string, string> = {};
    if (!TC.title.trim()) e.title = 'أدخل العنوان';
    if (TC.kind === 'lecture' && !TC.file) e.file = 'أرفق ملف الفيديو أو الصوت';
    if (TC.kind === 'quiz' && !TC.qs.length) e.qs = 'أضف سؤالًا واحدًا على الأقل';
    if (Object.keys(e).length) { up('tc', { errors: e }); return; }
    up('tc', { title: '', file: null, qs: [], errors: {} });
    back();
    toast(TC.kind === 'lecture' ? 'حُفظت المحاضرة كمسودة بانتظار النشر' : 'حُفظ الاختبار كمسودة');
  };
  const dashed = { flex: 1, minHeight: 48, borderRadius: 12, border: `1.5px dashed ${color.borderStrong}`, background: 'transparent', color: color.primary, fontWeight: 700, cursor: 'pointer', display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'center' } as const;
  return (
    <div>
      <BackHeader title="إنشاء محتوى" />
      <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Segmented role="group" label="نوع المحتوى" h={48} options={[['lecture', 'محاضرة'], ['quiz', 'اختبار']] as const} value={TC.kind} onChange={(k) => up('tc', { kind: k, errors: {} })} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="tc-title" style={labelStyle}>العنوان</label>
          <input id="tc-title" value={TC.title} aria-invalid={!!TC.errors.title} onChange={(e) => up('tc', { title: e.target.value, errors: { ...TC.errors, title: null } })} style={inputStyle(TC.errors.title)} />
          <FieldError msg={TC.errors.title} fs={12} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="tc-topic" style={labelStyle}>الموضوع</label>
            <select id="tc-topic" value={TC.topic} onChange={(e) => up('tc', { topic: e.target.value })} style={sel}>{['التجويد', 'الحفظ والمراجعة', 'آداب التلاوة', 'علوم القرآن'].map((o) => <option key={o}>{o}</option>)}</select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="tc-level" style={labelStyle}>المستوى</label>
            <select id="tc-level" value={TC.level} onChange={(e) => up('tc', { level: e.target.value })} style={sel}>{['مبتدئ', 'متوسط', 'متقدم', 'جميع المستويات'].map((o) => <option key={o}>{o}</option>)}</select>
          </div>
        </div>
        {TC.kind === 'lecture' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={labelStyle}>ملف الفيديو أو الصوت</span>
            {!TC.file ? (
              <button onClick={() => up('tc', { file: 'درس-النون-الساكنة.mp4 · 84 م.ب', errors: { ...TC.errors, file: null } })}
                style={{ minHeight: 96, borderRadius: 14, border: `1.5px dashed ${color.borderStrong}`, background: color.card, color: color.primary, fontSize: 15, fontWeight: 700, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, cursor: 'pointer' }}>
                <Icon name="upload" /> اختر ملفًا (MP4 أو MP3)
              </button>
            ) : (
              <div style={{ minHeight: 56, borderRadius: 14, border: `1px solid ${color.border}`, background: color.card, display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px' }}>
                <span style={{ color: color.primary }}><Icon name="file" /></span><span style={{ flex: 1, fontSize: 14 }} dir="auto">{TC.file}</span>
                <button onClick={() => up('tc', { file: null })} aria-label="إزالة الملف" style={{ width: 44, height: 44, border: 'none', background: 'transparent', color: color.dangerInk, display: 'grid', placeItems: 'center', cursor: 'pointer' }}><Icon name="trash" size={18} /></button>
              </div>
            )}
            <p style={muted(12)}>اختيار ملف تجريبي — يحتاج ربطًا بالتخزين.</p>
            <FieldError msg={TC.errors.file} fs={12} />
          </div>
        )}
        {TC.kind === 'quiz' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={labelStyle}>الأسئلة</span>
            {TC.qs.map((x, i) => (
              <div key={i} style={{ ...card, borderRadius: 14, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>السؤال {i + 1} · {x.rec ? 'سؤال تلاوة · يقيّمه المعلم' : 'اختيار من متعدد'}</span>
                  <button onClick={() => up('tc', { qs: TC.qs.filter((_, j) => j !== i) })} aria-label="حذف السؤال" style={{ width: 40, height: 40, border: 'none', background: 'transparent', color: color.dangerInk, display: 'grid', placeItems: 'center', cursor: 'pointer' }}><Icon name="trash" size={18} /></button>
                </div>
                <input value={x.text} onChange={(e) => up('tc', { qs: TC.qs.map((y, j) => (j === i ? { ...y, text: e.target.value } : y)) })} aria-label="نص السؤال" placeholder="اكتب نص السؤال"
                  style={{ minHeight: 48, padding: '0 12px', borderRadius: 10, border: `1.5px solid ${color.borderInput}`, background: color.ivory, fontSize: 15 }} />
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => up('tc', { qs: [...TC.qs, { text: '', rec: false }], errors: { ...TC.errors, qs: null } })} style={dashed}><Icon name="plus" size={18} /> اختيار من متعدد</button>
              <button onClick={() => up('tc', { qs: [...TC.qs, { text: '', rec: true }], errors: { ...TC.errors, qs: null } })} style={dashed}><Icon name="mic" size={18} /> سؤال تلاوة</button>
            </div>
            <FieldError msg={TC.errors.qs} fs={12} />
          </div>
        )}
        <button onClick={save} style={primaryBtn()}>حفظ كمسودة</button>
      </div>
    </div>
  );
}

/* ---------------- Live schedule (teacher's real sessions) ---------------- */
const ATT_OPTS = [['present', 'حضر'], ['late', 'متأخر'], ['absent', 'غاب'], ['excused', 'بعذر']] as const;
const hhmm = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const hoursToHHMM = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
const labelHHMM = (v: string) => { const [h, m] = v.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'ص' : 'م'}`; };

function TodayLive() {
  const s = useApp(); const tz = tzOf(s.tz).iana;
  const today = (s.tsched ?? []).filter((o) => o.bookings.length && dayLabel(o.starts_at, tz) === 'اليوم');
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>جلسات اليوم</h2>
      {today.length === 0 && <p style={muted(14)}>لا توجد جلسات محجوزة اليوم.</p>}
      {today.map((o) => (
        <button key={o.id} onClick={() => { up('sched', { tab: 'sessions' }); tab('tschedule'); }} style={{ ...card, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
          <span style={{ minWidth: 64, textAlign: 'center', fontSize: 16, fontWeight: 800 }}>{fmtTime(o.starts_at, tz)}</span>
          <span style={{ flex: 1, minWidth: 0, borderRight: `1px solid ${color.divider}`, paddingRight: 12 }}>
            <span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{o.bookings.map((b) => b.student_name).join('، ')}</span>
            <span style={{ display: 'block', fontSize: 12, color: color.muted, marginTop: 2 }}>{o.kind === 'group' ? 'جماعية' : 'فردية'} · {o.bookings[0].assignment_title || 'بدون مهمة محددة'}</span>
          </span>
        </button>
      ))}
    </section>
  );
}

function ScheduleLive() {
  const s = useApp(); const SD = s.sched; const tz = tzOf(s.tz).iana; const occ = s.tsched ?? [];
  const now = Date.now();
  const booked = occ.filter((o) => o.bookings.length && new Date(o.ends_at).getTime() > now - 7 * 86_400_000);
  const days = weekDays(s);
  const dayIso = new Date(Date.now() + SD.day * 86_400_000).toISOString();
  const key = dateKey(dayIso, tz);
  const dayOcc = occ.filter((o) => dateKey(o.starts_at, tz) === key);
  const times = [...new Set([...BASE_HOURS.map(hoursToHHMM), ...dayOcc.map((o) => hhmm(o.starts_at, tz))])].sort();
  return (
    <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1 style={{ margin: '12px 0 0', fontSize: 24, fontWeight: 800 }}>المواعيد</h1>
      <Segmented role="tablist" options={[['sessions', 'الجلسات'], ['avail', 'الإتاحة']] as const} value={SD.tab} onChange={(k) => up('sched', { tab: k })} />
      {SD.tab === 'sessions' && <>
        {booked.length === 0 && <p style={muted(15, { padding: 24, textAlign: 'center' })}>لا توجد جلسات محجوزة.</p>}
        {booked.map((o) => {
          const started = new Date(o.starts_at).getTime() <= now;
          return (
            <div key={o.id} style={{ ...card, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span style={{ fontSize: 15, fontWeight: 700 }}>{dayLabel(o.starts_at, tz)} · {fmtTime(o.starts_at, tz)} <span style={{ fontWeight: 500, color: color.muted, fontSize: 13 }}>· {o.kind === 'group' ? 'جماعية' : 'فردية'}</span></span>
              {o.bookings.map((b) => (
                <div key={b.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${color.divider}`, paddingTop: 8 }}>
                  <span style={{ fontSize: 14 }}><strong>{b.student_name}</strong>{b.assignment_title ? ` · ${b.assignment_title}` : ''}</span>
                  {b.note && <span style={muted(13)}>ملاحظة الطالب: {b.note}</span>}
                  {started ? (
                    <div role="radiogroup" aria-label={`حضور ${b.student_name}`} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {ATT_OPTS.map(([v, l]) => {
                        const on = b.attendance === v;
                        return <button key={v} role="radio" aria-checked={on} onClick={() => setAttendance(b.id, v)} style={{ minHeight: 40, padding: '0 12px', borderRadius: 999, border: `1.5px solid ${on ? color.primary : color.borderStrong}`, background: on ? color.primary : color.card, color: on ? color.ivory : color.primary, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>{l}</button>;
                      })}
                    </div>
                  ) : (
                    <button onClick={() => openSheet({ kind: 'confirm', title: 'إلغاء الحجز؟', body: `سيُلغى موعد ${b.student_name} ويصله إشعار بذلك.`, ok: 'نعم، ألغِ الحجز', danger: true, onOk: () => { setState({ sheet: null }); teacherCancelBooking(b.id); } })}
                      style={{ alignSelf: 'flex-start', minHeight: 40, padding: '0 12px', borderRadius: 10, border: `1px solid ${color.dangerInk}`, background: 'transparent', color: color.dangerInk, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>إلغاء الحجز</button>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </>}
      {SD.tab === 'avail' && <>
        <p style={muted(13, { display: 'flex', gap: 6, alignItems: 'center' })}><Icon name="globe" size={18} /> الأوقات {tzLabel(s.tz)}، وتظهر لكل طالب بتوقيته.</p>
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', margin: '0 -16px', padding: '2px 16px' }}>
          {days.map((d, i) => {
            const on = SD.day === i;
            return (
              <button key={i} aria-pressed={on} onClick={() => up('sched', { day: i })} style={{ flexShrink: 0, width: 64, minHeight: 68, borderRadius: 14, border: `1.5px solid ${on ? color.primary : color.borderChip}`, background: on ? color.primary : color.card, color: on ? color.ivory : color.ink, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>{d.label}</span>
                <span style={{ fontFamily: font.latin, fontSize: 18, fontWeight: 700 }}>{d.num}</span>
              </button>
            );
          })}
        </div>
        <div style={{ ...card, padding: '4px 14px' }}>
          {times.map((t) => {
            const o = dayOcc.find((x) => hhmm(x.starts_at, tz) === t);
            const isBooked = !!o?.bookings.length;
            const past = new Date(zonedIso(key, t, tz)).getTime() < now + 60 * 60_000;
            const stt = isBooked ? 'محجوز' : o ? 'متاح' : 'غير متاح';
            const label = labelHHMM(t);
            return (
              <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 56, borderBottom: `1px solid ${color.divider}` }}>
                <span style={{ flex: 1, fontSize: 16, fontWeight: 700, color: past ? color.muted : color.ink }}>{label}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: isBooked ? color.warnInk : o ? color.primary : color.muted }}>{stt}</span>
                <Switch on={!!o} label={`إتاحة ${label}`} onToggle={() => {
                  if (isBooked) { toast('لا يمكن إغلاق موعد محجوز من هنا؛ ألغِ الحجز من تبويب الجلسات', 'alert'); return; }
                  if (past) { toast('لا يمكن تعديل موعد مضى أو يبدأ خلال ساعة', 'alert'); return; }
                  toggleLiveSlot(key, t, o?.id ?? null);
                }} />
              </div>
            );
          })}
        </div>
        <p style={muted(12)}>الإتاحة الأسبوعية الثابتة تضبطها الإدارة؛ هنا تفتح أو تغلق مواعيد محددة.</p>
      </>}
    </div>
  );
}

/** One quiz recitation / short answer awaiting the teacher's grade. */
function GradeCard({ g }: { g: ApiGradingItem }) {
  const [pts, setPts] = useState<number | null>(null); const [reason, setReason] = useState('');
  return (
    <div style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontSize: 15, fontWeight: 700 }}>{g.student_name} · {g.test_title}</span>
      <span style={{ fontSize: 14, color: color.body }}>{g.prompt}</span>
      {g.recording ? <audio controls preload="none" src={g.recording.url} style={{ width: '100%' }} aria-label={`تسجيل ${g.student_name}`} />
        : <p style={{ margin: 0, fontSize: 14 }}>الإجابة: {String(g.response ?? '—')}</p>}
      <div role="radiogroup" aria-label="الدرجة" style={{ display: 'flex', gap: 6 }}>
        {Array.from({ length: g.points + 1 }, (_, n) => (
          <button key={n} role="radio" aria-checked={pts === n} onClick={() => setPts(n)}
            style={{ flex: 1, minHeight: 44, borderRadius: 10, border: `1.5px solid ${pts === n ? color.primary : color.borderStrong}`, background: pts === n ? color.primary : color.card, color: pts === n ? color.ivory : color.primary, fontFamily: font.latin, fontWeight: 700, cursor: 'pointer' }}>{n}</button>
        ))}
      </div>
      <input aria-label="ملاحظة (اختياري)" placeholder="ملاحظة (اختياري)" value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle(null, false, { fontSize: 14 })} />
      <button disabled={pts === null} onClick={() => pts !== null && gradeRecitation(g.answer, pts, reason)} style={primaryBtn(48, 15, { opacity: pts === null ? 0.6 : 1 })}>حفظ الدرجة (من {g.points})</button>
    </div>
  );
}
