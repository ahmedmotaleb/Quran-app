/** Live Circles and Bookings sections (pack prompt 06). Every action is a server call; lists re-read after writes. */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { color, font } from '@/theme/tokens';
import { FieldError, inputStyle, labelStyle, primaryBtn } from '@/components/ui';
import { Icon } from '@/components/Icon';
import type { ApiError } from '@/api/client';
import { toast } from '../adminStore';
import * as A from './api';
import { chip, dateTime, errMsg, Modal, ReasonDialog, smallBtn } from './ui';
import {
  BulkBar, type BulkDef, circleOptions, type Col, DataView, type FilterField, FilterControls, filterOf, items, listParams, Pager,
  SelectionSummary, studentOptions, teacherOptions, useListUrl, useSelection, useServerList, useUrlSearch, InlineSelectHeader, Checkbox,
} from './list';

const CIRCLE_ST: Record<A.CircleState, { l: string; bg: string; fg: string }> = {
  draft: { l: 'مسودة', bg: '#ECE7DB', fg: '#45534E' }, published: { l: 'منشورة', bg: '#D8E5D7', fg: '#124C46' }, off: { l: 'موقوفة', bg: '#F5E1DC', fg: '#8E2F20' },
};
const BOOK_ST: Record<string, { l: string; bg: string; fg: string }> = {
  confirmed: { l: 'مؤكدة', bg: '#D8E5D7', fg: '#124C46' }, cancelled: { l: 'ملغاة', bg: '#F5E1DC', fg: '#8E2F20' },
};
const ATT: Record<string, string> = { present: 'حضر', late: 'متأخر', absent: 'غاب', excused: 'غاب بعذر' };
const DAYS = ['الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد']; // Python weekday order (0 = Monday)
const pill = (t: { l: string; bg: string; fg: string }) => <span style={{ display: 'inline-block', padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700, background: t.bg, color: t.fg, whiteSpace: 'nowrap' }}>{t.l}</span>;

/* =============================== Circles =============================== */
const CIRCLE_FIELDS: FilterField[] = [
  { key: 'state', label: 'الحالة', type: 'select', options: [['draft', 'مسودة'], ['published', 'منشورة'], ['off', 'موقوفة']] },
  { key: 'teacher', label: 'المعلم', type: 'remote', load: teacherOptions },
  { key: 'has_upcoming', label: 'الجلسات', type: 'bool', yes: 'لها جلسات قادمة', no: 'دون جلسات قادمة' },
  { key: 'created', label: 'تاريخ الإنشاء', type: 'dates', from: 'created_from', to: 'created_to' },
];
const CIRCLE_ACTIONS: BulkDef[] = [
  { key: 'publish', label: 'نشر', tone: 'primary', body: (n) => `ستظهر ${items(n)} للطلاب ويمكن حجز جلساتها. تُترك الحلقات التي معلمها غير معتمد.`, ok: (n) => `نشر ${items(n)}` },
  { key: 'disable', label: 'تعطيل', reason: true, body: (n) => `ستختفي ${items(n)} عن الطلاب ولن تُقبل حجوزات جديدة. الحجوزات الحالية تبقى.`, ok: (n) => `تعطيل ${items(n)}` },
  { key: 'delete', label: 'حذف المحدد', tone: 'danger', destructive: true,
    body: (n) => `أنت على وشك حذف ${items(n)}. لا يمكن التراجع عن هذا الإجراء. تُحذف المسودات التي لم تُجدول لها جلسات فقط؛ أما الحلقات ذات السجل فتبقى كما هي.`, ok: (n) => `حذف ${items(n)}` },
];

export function CirclesLive() {
  const { q, update } = useListUrl('circles');
  const [text, setText] = useUrlSearch(q, update);
  const sort = q.sort ?? '-updated'; const page = Number(q.page ?? 1) || 1;
  const params = { ...listParams(q), sort, page: String(page) };
  const L = useServerList((p) => A.listCircles(p), params);
  const filter = filterOf(params); const sel = useSelection(JSON.stringify(filter));
  const [open, setOpen] = useState<number | null>(null); const [adding, setAdding] = useState(false);
  const cur = q.state ?? 'all';
  const cols: Col<A.Circle>[] = [
    { key: 'name', label: 'الحلقة', sort: 'name', primary: true, cell: (c) => <button onClick={() => setOpen(c.id)} style={{ border: 'none', background: 'transparent', padding: 0, font: 'inherit', fontWeight: 700, color: color.primary, cursor: 'pointer', textDecoration: 'underline', minHeight: 32 }}>{c.name}</button> },
    { key: 't', label: 'المعلم', cell: (c) => c.teacher.name },
    { key: 'l', label: 'المستوى', cell: (c) => c.level || '—' },
    { key: 'cap', label: 'السعة', sort: 'capacity', latin: true, cell: (c) => c.capacity },
    { key: 'up', label: 'الجلسات القادمة', latin: true, cell: (c) => c.upcoming_sessions },
    { key: 'bk', label: 'المقاعد المحجوزة', latin: true, cell: (c) => c.upcoming_booked_seats },
    { key: 'st', label: 'الحالة', sort: 'state', cell: (c) => pill(CIRCLE_ST[c.state]) },
  ];
  return (
    <>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="search" aria-label="ابحث باسم الحلقة أو المعلم" placeholder="ابحث باسم الحلقة أو المعلم" value={text} onChange={(e) => setText(e.target.value)}
          style={{ flex: '1 1 240px', minHeight: 48, padding: '0 14px', borderRadius: 12, border: `1.5px solid ${color.borderInput}`, background: color.card, fontSize: 15 }} />
        <FilterControls fields={CIRCLE_FIELDS} q={q} update={update} />
        <button onClick={() => setAdding(true)} style={primaryBtn(48, 15, { padding: '0 16px', borderRadius: 12, gap: 6, marginInlineStart: 'auto' })}><Icon name="plus" size={18} /> حلقة جديدة</button>
      </div>
      <div role="group" aria-label="تصفية حسب الحالة" style={{ display: 'flex', gap: 8, overflowX: 'auto' }}>
        {[['all', 'الكل'], ['draft', 'مسودة'], ['published', 'منشورة'], ['off', 'موقوفة']].map(([k, l]) => <button key={k} aria-pressed={cur === k} onClick={() => update({ state: k === 'all' ? '' : k })} style={chip(cur === k)}>{l}</button>)}
      </div>
      <SelectionSummary sel={sel} pageIds={L.data?.results.map((r) => r.id) ?? []} total={L.data?.count ?? 0} />
      <DataView rows={L.data?.results} cols={cols} sel={sel} total={L.data?.count ?? 0} rowLabel={(c) => c.name} sort={sort} setSort={(x) => update({ sort: x })}
        loading={L.loading} err={L.err} retry={() => void L.reload()} />
      <Pager page={page} total={L.data?.count ?? 0} setPage={(p) => update({ page: String(p) })} />
      <BulkBar resource="circles" sel={sel} total={L.data?.count ?? 0} actions={CIRCLE_ACTIONS} filter={filter} onDone={() => void L.reload()} />
      {adding && <CircleForm onClose={() => setAdding(false)} onSaved={(c) => { setAdding(false); void L.reload(); setOpen(c.id); }} />}
      {open !== null && <CirclePanel id={open} onClose={() => setOpen(null)} onChanged={() => void L.reload()} />}
    </>
  );
}

function CircleForm({ circle, onClose, onSaved }: { circle?: A.Circle; onClose: () => void; onSaved: (c: A.Circle) => void }) {
  const [f, setF] = useState({ name: circle?.name ?? '', teacher: circle?.teacher.id ?? 0, capacity: String(circle?.capacity ?? 8), level: circle?.level ?? '', note: circle?.schedule_note ?? '' });
  const [teachers, setTeachers] = useState<A.Person[]>([]); const [err, setErr] = useState<Record<string, string | null>>({}); const [busy, setBusy] = useState(false);
  useEffect(() => { if (!circle) A.listPeople({ role: 'teacher', status: 'active', page_size: 100 }).then((p) => setTeachers(p.results.filter((t) => t.approved))).catch(() => setTeachers([])); }, [circle]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const cap = Number(f.capacity); const x: Record<string, string> = {};
    if (f.name.trim().length < 2) x.name = 'اكتب اسم الحلقة.';
    if (!circle && !f.teacher) x.teacher = 'اختر المعلم.';
    if (!Number.isInteger(cap) || cap < 2 || cap > 40) x.capacity = 'السعة من 2 إلى 40.';
    if (Object.keys(x).length) return setErr(x);
    setBusy(true); setErr({});
    try {
      const d = { name: f.name.trim(), capacity: cap, level: f.level.trim(), schedule_note: f.note.trim() };
      onSaved(circle ? await A.updateCircle(circle.id, d) : await A.createCircle({ ...d, teacher: f.teacher }));
      toast('حُفظت الحلقة');
    } catch (y) { const a = y as ApiError; setErr({ name: a.field?.('name') ?? null, capacity: a.field?.('capacity') ?? null, teacher: a.field?.('teacher') ?? null, form: a.message }); }
    finally { setBusy(false); }
  };
  const field = (id: string, label: string, el: ReactNode, e?: string | null) => (<><label htmlFor={id} style={labelStyle}>{label}</label>{el}<FieldError msg={e} /></>);
  return (
    <Modal title={circle ? 'تعديل الحلقة' : 'حلقة جديدة'} onClose={onClose}>
      <form noValidate onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {field('ci-n', 'اسم الحلقة', <input id="ci-n" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={inputStyle(err.name)} />, err.name)}
        {!circle && field('ci-t', 'المعلم (المعتمدون فقط)', (
          <select id="ci-t" value={f.teacher} onChange={(e) => setF({ ...f, teacher: Number(e.target.value) })} style={inputStyle(err.teacher)}>
            <option value={0}>— اختر —</option>{teachers.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
          </select>), err.teacher)}
        {field('ci-c', 'السعة (عدد الطلاب)', <input id="ci-c" inputMode="numeric" dir="ltr" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value.replace(/\D/g, '') })} style={inputStyle(err.capacity, true)} />, err.capacity)}
        {field('ci-l', 'المستوى', <input id="ci-l" value={f.level} placeholder="مبتدئ / متوسط / متقدم" onChange={(e) => setF({ ...f, level: e.target.value })} style={inputStyle(null)} />)}
        {field('ci-s', 'وصف الموعد (يظهر للإدارة)', <input id="ci-s" value={f.note} placeholder="مثال: الأحد والثلاثاء بعد العصر" onChange={(e) => setF({ ...f, note: e.target.value })} style={inputStyle(null)} />)}
        {err.form && !err.name && !err.capacity && !err.teacher && <FieldError msg={err.form} />}
        <button type="submit" disabled={busy} style={{ ...primaryBtn(48, 15), marginTop: 6 }}>{busy ? 'جارٍ الحفظ…' : 'حفظ'}</button>
      </form>
    </Modal>
  );
}

function CirclePanel({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const [c, setC] = useState<(A.Circle & { sessions: A.SessionRow[] }) | null>(null); const [err, setErr] = useState<string | null>(null);
  const [sub, setSub] = useState<'edit' | 'schedule' | { reason: 'off' } | { cancel: A.SessionRow } | null>(null); const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => { try { setC(await A.getCircle(id)); setErr(null); } catch (e) { setErr(errMsg(e)); } }, [id]);
  useEffect(() => { void reload(); }, [reload]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); try { await fn(); toast(ok); await reload(); onChanged(); } catch (e) { toast(errMsg(e)); } finally { setBusy(false); } };
  const sel = useSelection(String(id));
  const cancellable = (c?.sessions ?? []).filter((s) => s.status === 'scheduled' && new Date(s.starts_at) > new Date()).map((s) => s.id);
  return (
    <Modal title={c?.name ?? 'الحلقة'} onClose={onClose} wide>
      {err && <p role="alert" style={{ margin: 0, color: color.danger }}>{err}</p>}
      {!c && !err && <p role="status" style={{ margin: 0, color: color.muted }}>جارٍ التحميل…</p>}
      {c && <>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {pill(CIRCLE_ST[c.state])}<span>{c.teacher.name}</span><span style={{ color: color.muted }}>· السعة {c.capacity}{c.level ? ` · ${c.level}` : ''}</span>
        </div>
        {c.schedule_note && <p style={{ margin: 0, color: color.muted, fontSize: 14 }}>{c.schedule_note}</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setSub('edit')} style={smallBtn()}>تعديل</button>
          <button onClick={() => setSub('schedule')} style={smallBtn()}>جدولة جلسات</button>
          {c.state !== 'published' && <button disabled={busy} onClick={() => act(() => A.setCircleState(c.id, 'published'), 'نُشرت الحلقة')} style={smallBtn('primary')}>نشر</button>}
          {c.state === 'published' && <button disabled={busy} onClick={() => setSub({ reason: 'off' })} style={smallBtn('danger')}>إيقاف</button>}
          {c.state === 'off' && <button disabled={busy} onClick={() => act(() => A.setCircleState(c.id, 'draft'), 'أُعيدت إلى مسودة')} style={smallBtn()}>إعادة إلى مسودة</button>}
        </div>
        {c.state !== 'published' && <p style={{ margin: 0, fontSize: 13, color: color.muted }}>جلسات الحلقة لا تظهر للطلاب ولا تُحجز إلا بعد النشر.</p>}
        <section style={{ borderTop: `1px solid ${color.divider}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>الجلسات (بتوقيت القاهرة)</h3>
          {c.sessions.length === 0 && <p style={{ margin: 0, color: color.muted }}>لا توجد جلسات بعد. اختر «جدولة جلسات».</p>}
          {cancellable.length > 1 && <InlineSelectHeader sel={sel} ids={cancellable} what="الجلسات القادمة" />}
          {c.sessions.map((s) => (
            <div key={s.id} style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 44, borderTop: `1px solid ${color.divider}` }}>
              {cancellable.length > 1 && (cancellable.includes(s.id) ? <Checkbox checked={sel.has(s.id)} onChange={() => sel.toggle(s.id)} label={`تحديد جلسة ${dateTime(s.starts_at)}`} /> : <span style={{ width: 22 }} />)}
              <span style={{ flex: 1 }}>{dateTime(s.starts_at)}</span>
              <span style={{ fontFamily: font.latin, color: color.muted }}>{s.booked}/{s.capacity}</span>
              {s.status === 'scheduled' ? <button disabled={busy || new Date(s.starts_at) <= new Date()} onClick={() => setSub({ cancel: s })} style={smallBtn('danger')}>إلغاء الجلسة</button>
                : pill(s.status === 'cancelled' ? BOOK_ST.cancelled : { l: 'مكتملة', bg: '#ECE7DB', fg: '#45534E' })}
            </div>
          ))}
        </section>
      </>}
      <BulkBar resource="sessions" sel={sel} total={cancellable.length} filter={{}} onDone={() => { void reload(); onChanged(); }} actions={[
        { key: 'cancel', label: 'إلغاء الجلسات', tone: 'danger', reason: true, title: 'إلغاء الجلسات',
          body: (n) => `ستُلغى ${items(n)} وكل حجوزاتها، ويُبلَّغ الطلاب. يبقى السجل محفوظًا.`, ok: (n) => `إلغاء ${items(n)}` }]} />
      {sub === 'edit' && c && <CircleForm circle={c} onClose={() => setSub(null)} onSaved={() => { setSub(null); void reload(); onChanged(); }} />}
      {sub === 'schedule' && c && <ScheduleDialog circle={c} onClose={() => setSub(null)} onDone={() => { void reload(); onChanged(); }} />}
      {sub && typeof sub === 'object' && 'reason' in sub && c && (
        <ReasonDialog title="إيقاف الحلقة" body="ستختفي جلسات الحلقة عن الطلاب ولن تُقبل حجوزات جديدة. الحجوزات الحالية تبقى حتى تلغيها." ok="إيقاف"
          onClose={() => setSub(null)} run={async (r) => { await A.setCircleState(c.id, 'off', r); toast('أُوقفت الحلقة'); await reload(); onChanged(); }} />
      )}
      {sub && typeof sub === 'object' && 'cancel' in sub && (
        <ReasonDialog title="إلغاء الجلسة" body={`سيُلغى ${sub.cancel.booked} حجز${sub.cancel.booked ? ' ويُبلَّغ أصحابها' : ''}. يبقى السجل محفوظًا.`} ok="إلغاء الجلسة"
          onClose={() => setSub(null)} run={async (r) => { const x = await A.cancelSession(sub.cancel.id, r); toast(`أُلغيت الجلسة (${x.bookings_cancelled} حجز)`); await reload(); onChanged(); }} />
      )}
    </Modal>
  );
}

function ScheduleDialog({ circle, onClose, onDone }: { circle: A.Circle; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ weekday: 6, time: '17:00', minutes: '60', weeks: '4' });
  const [plan, setPlan] = useState<A.PlanItem[] | null>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const body = (dry: boolean) => ({ weekday: f.weekday, time: f.time, minutes: Number(f.minutes), weeks: Number(f.weeks), timezone: 'Africa/Cairo', dry_run: dry });
  const valid = () => /^\d{2}:\d{2}$/.test(f.time) && Number(f.minutes) >= 15 && Number(f.minutes) <= 240 && Number(f.weeks) >= 1 && Number(f.weeks) <= 26;
  const preview = async (e?: FormEvent) => {
    e?.preventDefault(); if (!valid()) return setErr('تحقق من الوقت (15–240 دقيقة) وعدد الأسابيع (1–26).');
    setBusy(true); setErr(null);
    try { setPlan((await A.scheduleCircle(circle.id, body(true))).plan); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await A.scheduleCircle(circle.id, body(false));
      toast(`أُضيفت ${r.created} جلسة${r.replaced_open_slots ? ` واستُبدل ${r.replaced_open_slots} موعد فردي غير محجوز` : ''}`); onDone(); onClose();
    } catch (x) { setErr(errMsg(x)); setBusy(false); }
  };
  const ok = plan?.filter((p) => p.ok).length ?? 0;
  return (
    <Modal title="جدولة جلسات أسبوعية" onClose={onClose}>
      <form noValidate onSubmit={preview} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label htmlFor="sc-d" style={labelStyle}>اليوم</label>
        <select id="sc-d" value={f.weekday} onChange={(e) => { setF({ ...f, weekday: Number(e.target.value) }); setPlan(null); }} style={inputStyle(null)}>
          {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </select>
        <label htmlFor="sc-t" style={labelStyle}>الوقت (بتوقيت القاهرة)</label>
        <input id="sc-t" type="time" dir="ltr" value={f.time} onChange={(e) => { setF({ ...f, time: e.target.value }); setPlan(null); }} style={inputStyle(null, true)} />
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}><label htmlFor="sc-m" style={labelStyle}>المدة (دقيقة)</label>
            <input id="sc-m" inputMode="numeric" dir="ltr" value={f.minutes} onChange={(e) => { setF({ ...f, minutes: e.target.value.replace(/\D/g, '') }); setPlan(null); }} style={inputStyle(null, true)} /></div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}><label htmlFor="sc-w" style={labelStyle}>عدد الأسابيع</label>
            <input id="sc-w" inputMode="numeric" dir="ltr" value={f.weeks} onChange={(e) => { setF({ ...f, weeks: e.target.value.replace(/\D/g, '') }); setPlan(null); }} style={inputStyle(null, true)} /></div>
        </div>
        <FieldError msg={err} />
        {!plan && <button type="submit" disabled={busy} style={primaryBtn(48, 15)}>{busy ? 'جارٍ التحقق…' : 'معاينة'}</button>}
      </form>
      {plan && <>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }} aria-label="المعاينة">
          {plan.map((p) => (
            <li key={p.starts_at} style={{ display: 'flex', gap: 8, fontSize: 14, color: p.ok ? color.ink : color.danger }}>
              <Icon name={p.ok ? 'check' : 'alert'} size={16} /> {dateTime(p.starts_at)}{p.problem ? ` — ${p.problem}` : ''}
            </li>
          ))}
        </ul>
        <button onClick={save} disabled={busy || ok === 0} style={primaryBtn(48, 15)}>{busy ? 'جارٍ الحفظ…' : `إضافة ${ok} جلسة`}</button>
      </>}
    </Modal>
  );
}

/* =============================== Bookings =============================== */
const BOOKING_FIELDS: FilterField[] = [
  { key: 'when', label: 'الوقت', type: 'select', options: [['upcoming', 'القادمة'], ['past', 'السابقة'], ['all', 'الكل']] },
  { key: 'status', label: 'الحالة', type: 'select', options: [['confirmed', 'مؤكدة'], ['cancelled', 'ملغاة']] },
  { key: 'attendance', label: 'الحضور', type: 'select', options: [['present', 'حضر'], ['late', 'متأخر'], ['absent', 'غاب'], ['excused', 'غاب بعذر'], ['unmarked', 'لم يُسجَّل']] },
  { key: 'teacher', label: 'المعلم', type: 'remote', load: teacherOptions },
  { key: 'student', label: 'الطالب', type: 'remote', load: studentOptions },
  { key: 'circle', label: 'الحلقة', type: 'remote', load: circleOptions },
  { key: 'dates', label: 'تاريخ الجلسة', type: 'dates', from: 'from', to: 'to' },
];
const BOOKING_ACTIONS: BulkDef[] = [
  { key: 'cancel', label: 'إلغاء الحجوزات', tone: 'danger', reason: true, title: 'إلغاء الحجوزات',
    body: (n) => `سيُلغى ${items(n)} ويُبلَّغ كل طالب. تبقى السجلات والحضور محفوظة. الجلسات التي بدأت لا تُلغى.`, ok: (n) => `إلغاء ${items(n)}` },
];

export function BookingsLive() {
  const { q, update } = useListUrl('bookings');
  const [text, setText] = useUrlSearch(q, update);
  const when = (q.when ?? 'upcoming') as 'upcoming' | 'past' | 'all';
  const sort = q.sort ?? (when === 'past' ? '-starts' : 'starts'); const page = Number(q.page ?? 1) || 1;
  const params = { ...listParams(q), when, sort, page: String(page) };
  const L = useServerList((p) => A.listBookings(p), params);
  const filter = filterOf(params); const sel = useSelection(JSON.stringify(filter));
  const [cancel, setCancel] = useState<A.Booking | null>(null);
  // Bookings change while the page is open (students book and cancel): refresh every minute.
  useEffect(() => { const t = setInterval(() => void L.reload(), 60000); return () => clearInterval(t); }, [L.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = q.status ?? 'all';
  const cols: Col<A.Booking>[] = [
    { key: 'at', label: 'الموعد (القاهرة)', sort: 'starts', primary: true, cell: (b) => dateTime(b.starts_at) },
    { key: 's', label: 'الطالب', sort: 'student', cell: (b) => b.student.name },
    { key: 't', label: 'المعلم', sort: 'teacher', cell: (b) => b.teacher.name },
    { key: 'k', label: 'النوع', cell: (b) => (b.circle ? `حلقة: ${b.circle}` : b.kind === 'group' ? 'جماعية' : 'فردية') },
    { key: 'a', label: 'الحضور', cell: (b) => ATT[b.attendance] ?? '—' },
    { key: 'st', label: 'الحالة', sort: 'status', cell: (b) => <>{pill(BOOK_ST[b.status])}{b.status === 'cancelled' && b.cancel_reason && <span style={{ display: 'block', fontSize: 12, color: color.muted, marginTop: 4 }}>{b.cancelled_by ? `${b.cancelled_by}: ` : ''}{b.cancel_reason}</span>}</> },
    { key: 'x', label: 'إجراء', cell: (b) => (b.status === 'confirmed' && new Date(b.starts_at) > new Date()
      ? <button onClick={() => setCancel(b)} aria-label={`إلغاء حجز ${b.student.name}`} style={smallBtn('danger')}>إلغاء</button> : <span style={{ color: color.faint }}>—</span>) },
  ];
  return (
    <>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="search" aria-label="ابحث باسم الطالب أو المعلم أو الحلقة" placeholder="ابحث باسم الطالب أو المعلم أو الحلقة" value={text} onChange={(e) => setText(e.target.value)}
          style={{ flex: '1 1 240px', minHeight: 48, padding: '0 14px', borderRadius: 12, border: `1.5px solid ${color.borderInput}`, background: color.card, fontSize: 15 }} />
        <FilterControls fields={BOOKING_FIELDS} q={q} update={update} />
      </div>
      <div role="group" aria-label="تصفية" style={{ display: 'flex', gap: 8, overflowX: 'auto', flexWrap: 'wrap' }}>
        {([['upcoming', 'القادمة'], ['past', 'السابقة']] as const).map(([k, l]) => <button key={k} aria-pressed={when === k} onClick={() => update({ when: k === 'upcoming' ? '' : k, sort: '' })} style={chip(when === k)}>{l}</button>)}
        <span style={{ width: 1, background: color.divider }} />
        {[['all', 'كل الحالات'], ['confirmed', 'مؤكدة'], ['cancelled', 'ملغاة']].map(([k, l]) => <button key={k} aria-pressed={st === k} onClick={() => update({ status: k === 'all' ? '' : k })} style={chip(st === k)}>{l}</button>)}
      </div>
      <SelectionSummary sel={sel} pageIds={L.data?.results.map((r) => r.id) ?? []} total={L.data?.count ?? 0} />
      <DataView rows={L.data?.results} cols={cols} sel={sel} total={L.data?.count ?? 0} rowLabel={(b) => `${b.student.name} ${dateTime(b.starts_at)}`} sort={sort}
        setSort={(x) => update({ sort: x })} loading={L.loading} err={L.err} retry={() => void L.reload()} />
      <Pager page={page} total={L.data?.count ?? 0} setPage={(p) => update({ page: String(p) })} />
      <BulkBar resource="bookings" sel={sel} total={L.data?.count ?? 0} actions={BOOKING_ACTIONS} filter={filter} onDone={() => void L.reload()} />
      {cancel && (
        <ReasonDialog title="إلغاء الحجز" body={`سيُلغى حجز ${cancel.student.name} مع ${cancel.teacher.name} (${dateTime(cancel.starts_at)}) ويُبلَّغ الطالب. يبقى السجل محفوظًا.`} ok="إلغاء الحجز"
          onClose={() => setCancel(null)} run={async (r) => { await A.cancelBooking(cancel.id, r); toast('أُلغي الحجز وأُبلغ الطالب'); await L.reload(); }} />
      )}
    </>
  );
}
