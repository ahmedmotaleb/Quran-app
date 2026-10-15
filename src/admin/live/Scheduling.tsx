/** Live Circles and Bookings sections (pack prompt 06). Every action is a server call; lists re-read after writes. */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { color, font } from '@/theme/tokens';
import { FieldError, inputStyle, labelStyle, primaryBtn } from '@/components/ui';
import { Icon } from '@/components/Icon';
import type { ApiError } from '@/api/client';
import { toast } from '../adminStore';
import * as A from './api';
import { chip, dateTime, errMsg, Modal, Pager, ReasonDialog, SearchBar, smallBtn, Table, useDebounced, usePaged } from './ui';

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
export function CirclesLive() {
  const [q, setQ] = useState(''); const dq = useDebounced(q); const [f, setF] = useState('all');
  const L = usePaged((page) => A.listCircles({ q: dq, state: f === 'all' ? undefined : f, page }), [dq, f]);
  const [open, setOpen] = useState<number | null>(null); const [adding, setAdding] = useState(false);
  return (
    <>
      <SearchBar q={q} setQ={setQ} label="ابحث باسم الحلقة أو المعلم"
        action={<button onClick={() => setAdding(true)} style={primaryBtn(48, 15, { padding: '0 16px', borderRadius: 12, gap: 6, marginInlineStart: 'auto' })}><Icon name="plus" size={18} /> حلقة جديدة</button>} />
      <div role="group" aria-label="تصفية حسب الحالة" style={{ display: 'flex', gap: 8, overflowX: 'auto' }}>
        {[['all', 'الكل'], ['draft', 'مسودة'], ['published', 'منشورة'], ['off', 'موقوفة']].map(([k, l]) => <button key={k} aria-pressed={f === k} onClick={() => setF(k)} style={chip(f === k)}>{l}</button>)}
      </div>
      <Table cols={['الحلقة', 'المعلم', 'المستوى', 'السعة', 'الجلسات القادمة', 'المقاعد المحجوزة', 'الحالة']} loading={L.loading} err={L.err} empty={!L.data?.results.length} retry={() => void L.reload()}>
        {L.data?.results.map((c) => (
          <tr key={c.id} style={{ borderTop: `1px solid ${color.divider}` }}>
            <th scope="row" style={{ padding: '12px 16px', textAlign: 'right' }}>
              <button onClick={() => setOpen(c.id)} style={{ border: 'none', background: 'transparent', padding: 0, font: 'inherit', fontWeight: 700, color: color.primary, cursor: 'pointer', textDecoration: 'underline', minHeight: 32 }}>{c.name}</button>
            </th>
            <td style={{ padding: '12px 16px' }}>{c.teacher.name}</td>
            <td style={{ padding: '12px 16px' }}>{c.level || '—'}</td>
            <td style={{ padding: '12px 16px', fontFamily: font.latin }}>{c.capacity}</td>
            <td style={{ padding: '12px 16px', fontFamily: font.latin }}>{c.upcoming_sessions}</td>
            <td style={{ padding: '12px 16px', fontFamily: font.latin }}>{c.upcoming_booked_seats}</td>
            <td style={{ padding: '12px 16px' }}>{pill(CIRCLE_ST[c.state])}</td>
          </tr>
        ))}
      </Table>
      <Pager page={L.page} total={L.data?.count ?? 0} setPage={L.setPage} />
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
          {c.sessions.map((s) => (
            <div key={s.id} style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 44, borderTop: `1px solid ${color.divider}` }}>
              <span style={{ flex: 1 }}>{dateTime(s.starts_at)}</span>
              <span style={{ fontFamily: font.latin, color: color.muted }}>{s.booked}/{s.capacity}</span>
              {s.status === 'scheduled' ? <button disabled={busy || new Date(s.starts_at) <= new Date()} onClick={() => setSub({ cancel: s })} style={smallBtn('danger')}>إلغاء الجلسة</button>
                : pill(s.status === 'cancelled' ? BOOK_ST.cancelled : { l: 'مكتملة', bg: '#ECE7DB', fg: '#45534E' })}
            </div>
          ))}
        </section>
      </>}
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
export function BookingsLive() {
  const [q, setQ] = useState(''); const dq = useDebounced(q);
  const [when, setWhen] = useState<'upcoming' | 'past'>('upcoming'); const [st, setSt] = useState('all');
  const L = usePaged((page) => A.listBookings({ when, status: st === 'all' ? undefined : st, q: dq, page }), [dq, when, st]);
  const [cancel, setCancel] = useState<A.Booking | null>(null);
  // Bookings change while the page is open (students book and cancel): refresh every minute.
  useEffect(() => { const t = setInterval(() => void L.reload(), 60000); return () => clearInterval(t); }, [L.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <SearchBar q={q} setQ={setQ} label="ابحث باسم الطالب أو المعلم" />
      <div role="group" aria-label="تصفية" style={{ display: 'flex', gap: 8, overflowX: 'auto', flexWrap: 'wrap' }}>
        {([['upcoming', 'القادمة'], ['past', 'السابقة']] as const).map(([k, l]) => <button key={k} aria-pressed={when === k} onClick={() => setWhen(k)} style={chip(when === k)}>{l}</button>)}
        <span style={{ width: 1, background: color.divider }} />
        {[['all', 'كل الحالات'], ['confirmed', 'مؤكدة'], ['cancelled', 'ملغاة']].map(([k, l]) => <button key={k} aria-pressed={st === k} onClick={() => setSt(k)} style={chip(st === k)}>{l}</button>)}
      </div>
      <Table cols={['الموعد (القاهرة)', 'الطالب', 'المعلم', 'النوع', 'الحضور', 'الحالة', 'إجراء']} loading={L.loading} err={L.err} empty={!L.data?.results.length} retry={() => void L.reload()}>
        {L.data?.results.map((b) => (
          <tr key={b.id} style={{ borderTop: `1px solid ${color.divider}` }}>
            <th scope="row" style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 700 }}>{dateTime(b.starts_at)}</th>
            <td style={{ padding: '12px 16px' }}>{b.student.name}</td>
            <td style={{ padding: '12px 16px' }}>{b.teacher.name}</td>
            <td style={{ padding: '12px 16px' }}>{b.circle ? `حلقة: ${b.circle}` : b.kind === 'group' ? 'جماعية' : 'فردية'}</td>
            <td style={{ padding: '12px 16px' }}>{ATT[b.attendance] ?? '—'}</td>
            <td style={{ padding: '12px 16px' }}>{pill(BOOK_ST[b.status])}{b.status === 'cancelled' && b.cancel_reason && <span style={{ display: 'block', fontSize: 12, color: color.muted, marginTop: 4 }}>{b.cancelled_by ? `${b.cancelled_by}: ` : ''}{b.cancel_reason}</span>}</td>
            <td style={{ padding: '8px 16px' }}>
              {b.status === 'confirmed' && new Date(b.starts_at) > new Date()
                ? <button onClick={() => setCancel(b)} aria-label={`إلغاء حجز ${b.student.name}`} style={smallBtn('danger')}>إلغاء</button> : <span style={{ color: color.faint }}>—</span>}
            </td>
          </tr>
        ))}
      </Table>
      <Pager page={L.page} total={L.data?.count ?? 0} setPage={L.setPage} />
      {cancel && (
        <ReasonDialog title="إلغاء الحجز" body={`سيُلغى حجز ${cancel.student.name} مع ${cancel.teacher.name} (${dateTime(cancel.starts_at)}) ويُبلَّغ الطالب. يبقى السجل محفوظًا.`} ok="إلغاء الحجز"
          onClose={() => setCancel(null)} run={async (r) => { await A.cancelBooking(cancel.id, r); toast('أُلغي الحجز وأُبلغ الطالب'); await L.reload(); }} />
      )}
    </>
  );
}
