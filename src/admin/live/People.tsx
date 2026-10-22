/**
 * Live Students / Teachers / Parents sections: server-side search, status filter and pagination; a detail
 * panel whose every action is a server call. The screen only changes after the server confirms.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { color, font } from '@/theme/tokens';
import { FieldError, inputStyle, labelStyle, primaryBtn } from '@/components/ui';
import { Icon } from '@/components/Icon';
import type { ApiError } from '@/api/client';
import { toast } from '../adminStore';
import * as A from './api';
import { chip, date, errMsg, LinkBox, Modal, ReasonDialog, smallBtn } from './ui';
import {
  BulkBar, type BulkDef, circleOptions, type Col, courseOptions, DataView, ExportButton, type FilterField, FilterControls, filterOf, items, listParams, Pager,
  SavedViews, SelectionSummary, teacherOptions, useListUrl, useSelection, useServerList, useUrlSearch,
} from './list';

const ROLE_L: Record<A.Role, { one: string; many: string; search: string; sec: string }> = {
  student: { one: 'طالب', many: 'الطلاب', search: 'ابحث بالاسم أو البريد أو الهاتف أو الرقم', sec: 'students' },
  teacher: { one: 'معلم', many: 'المعلمون', search: 'ابحث عن معلم بالاسم أو البريد', sec: 'teachers' },
  parent: { one: 'ولي أمر', many: 'أولياء الأمور', search: 'ابحث عن ولي أمر بالاسم أو البريد', sec: 'parents' },
};
const ST: Record<A.AccountStatus, { l: string; bg: string; fg: string }> = {
  active: { l: 'نشط', bg: '#D8E5D7', fg: '#124C46' },
  pending: { l: 'بانتظار الاعتماد', bg: '#F3E6CC', fg: '#6B470C' },
  suspended: { l: 'موقوف', bg: '#F5E1DC', fg: '#8E2F20' },
  archived: { l: 'مؤرشف', bg: '#E4E1DA', fg: '#45534E' },
};

function Pill({ st }: { st: A.AccountStatus }) {
  const t = ST[st];
  return <span style={{ display: 'inline-block', padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700, background: t.bg, color: t.fg, whiteSpace: 'nowrap' }}>{t.l}</span>;
}

const STATUS_OPTS: [string, string][] = [['active', 'نشط'], ['suspended', 'موقوف'], ['pending', 'بانتظار الاعتماد'], ['archived', 'مؤرشف']];
const LEVELS: [string, string][] = [['مبتدئ', 'مبتدئ'], ['متوسط', 'متوسط'], ['متقدم', 'متقدم']];
const FIELDS: Record<A.Role, FilterField[]> = {
  student: [
    { key: 'status', label: 'الحالة', type: 'select', options: STATUS_OPTS },
    { key: 'teacher', label: 'المعلم', type: 'remote', load: teacherOptions },
    { key: 'circle', label: 'الحلقة', type: 'remote', load: circleOptions },
    { key: 'course', label: 'الدورة', type: 'remote', load: courseOptions },
    { key: 'level', label: 'المستوى', type: 'select', options: LEVELS },
    { key: 'upcoming', label: 'جلسة قادمة', type: 'bool', yes: 'لديه جلسة قادمة', no: 'دون جلسة قادمة' },
    { key: 'overdue_review', label: 'المراجعة', type: 'bool', yes: 'لديه مراجعة متأخرة', no: 'لا مراجعات متأخرة' },
    { key: 'joined', label: 'تاريخ الانضمام', type: 'dates', from: 'joined_from', to: 'joined_to' },
    { key: 'active', label: 'آخر نشاط', type: 'dates', from: 'active_from', to: 'active_to' },
  ],
  teacher: [
    { key: 'status', label: 'الحالة', type: 'select', options: STATUS_OPTS },
    { key: 'approved', label: 'الاعتماد', type: 'bool', yes: 'معتمد', no: 'غير معتمد' },
    { key: 'has_students', label: 'الطلاب', type: 'bool', yes: 'لديه طلاب', no: 'دون طلاب' },
    { key: 'has_slots', label: 'المواعيد', type: 'bool', yes: 'لديه مواعيد قادمة', no: 'دون مواعيد قادمة' },
    { key: 'circle', label: 'الحلقة', type: 'remote', load: circleOptions },
    { key: 'joined', label: 'تاريخ الانضمام', type: 'dates', from: 'joined_from', to: 'joined_to' },
    { key: 'active', label: 'آخر نشاط', type: 'dates', from: 'active_from', to: 'active_to' },
  ],
  parent: [
    { key: 'status', label: 'الحالة', type: 'select', options: STATUS_OPTS },
    { key: 'linked', label: 'الأبناء', type: 'bool', yes: 'مرتبط بابن', no: 'دون أبناء مرتبطين' },
    { key: 'joined', label: 'تاريخ الانضمام', type: 'dates', from: 'joined_from', to: 'joined_to' },
    { key: 'active', label: 'آخر نشاط', type: 'dates', from: 'active_from', to: 'active_to' },
  ],
};

const PRESETS: Record<A.Role, [string, Record<string, string>][]> = {
  student: [['طلاب بدون معلم', { unlinked: '1' }], ['مراجعات متأخرة', { overdue_review: '1' }], ['دون جلسة قادمة', { upcoming: '0', status: 'active' }], ['المؤرشفون', { status: 'archived' }]],
  teacher: [['معلمون دون مواعيد', { has_slots: '0', status: 'active' }], ['غير معتمدين', { approved: '0' }], ['دون طلاب', { has_students: '0' }]],
  parent: [['دون أبناء مرتبطين', { linked: '0' }], ['بانتظار الاعتماد', { status: 'pending' }]],
};

const publishedCircles = async (): Promise<[string, string][]> =>
  (await A.listCircles({ state: 'published', page_size: '100', sort: 'name' })).results.map((c) => [String(c.id), `${c.name} (${c.members ?? 0}/${c.capacity})`]);

function peopleActions(role: A.Role): BulkDef[] {
  const base: BulkDef[] = [
    { key: 'activate', label: 'تفعيل', tone: 'primary', body: (n) => `سيُفعَّل ${items(n)} ويستطيع أصحابها الدخول.`, ok: (n) => `تفعيل ${items(n)}` },
    { key: 'suspend', label: 'تعطيل', reason: true, title: 'تعطيل الحسابات', body: (n) => `سيُمنع أصحاب ${items(n)} من الدخول فورًا حتى إعادة التفعيل. لا يُحذف أي سجل.`, ok: (n) => `تعطيل ${items(n)}` },
    { key: 'archive', label: 'أرشفة', tone: 'danger', reason: true, destructive: true, title: 'تأكيد الأرشفة',
      body: (n) => `أنت على وشك أرشفة ${items(n)}. لن يستطيع أصحابها الدخول أو استعادة كلمة المرور. تبقى مهامهم وتقييماتهم وحضورهم محفوظة، ويمكن إعادة التفعيل لاحقًا.`, ok: (n) => `أرشفة ${items(n)}` },
  ];
  const approvedTeachers = async () => (await A.listPeople({ role: 'teacher', approved: '1', status: 'active', page_size: 100, sort: 'name' } as Parameters<typeof A.listPeople>[0]))
    .results.map((t) => [String(t.id), t.full_name] as [string, string]);
  if (role === 'student') base.push(
    { key: 'assign_teacher', label: 'تعيين معلم', title: 'تعيين معلم', params: [{ key: 'teacher', label: 'المعلم', type: 'remote', load: approvedTeachers }, { key: 'replace', label: 'إنهاء ارتباطهم بمعلميهم الحاليين', type: 'check' }],
      body: (n) => `سيُربط ${items(n)} بالمعلم المختار. من كان مرتبطًا به يُترك كما هو، والحسابات الموقوفة لا تتغيّر.`, ok: (n) => `تعيين لـ ${items(n)}` },
    { key: 'move_to_circle', label: 'نقل إلى حلقة', title: 'نقل إلى حلقة', params: [{ key: 'circle', label: 'الحلقة (المنشورة)', type: 'remote', load: publishedCircles }],
      body: (n) => `سينضم ${items(n)} إلى الحلقة ويُحجز لهم في كل جلساتها القادمة، وتنتهي عضويتهم في حلقاتهم الأخرى (تُلغى حجوزاتها القادمة فقط). لا يُتجاوز عدد مقاعد الحلقة.`,
      ok: (n) => `نقل ${items(n)}` },
    { key: 'enroll', label: 'إضافة إلى دورة', title: 'إضافة إلى دورة', params: [{ key: 'course', label: 'الدورة', type: 'remote', load: courseOptions }],
      body: (n) => `سيُسجَّل ${items(n)} في الدورة المختارة. المسجّل من قبل يُترك كما هو.`, ok: (n) => `تسجيل ${items(n)}` });
  base.push(
    { key: 'notify', label: 'رسالة داخل التطبيق', title: 'رسالة داخل التطبيق',
      params: [{ key: 'title', label: 'العنوان', type: 'text', max: 80 }, { key: 'body', label: 'نص الرسالة', type: 'textarea', max: 500, hint: 'تظهر في صندوق الإشعارات فقط؛ إشعار الهاتف يعرض نصًا عامًا دون محتوى الرسالة.' }],
      body: (n) => `ستصل الرسالة إلى ${items(n)} (عدا الحسابات الموقوفة والمؤرشفة). يُسجَّل المرسل والعدد في سجل التدقيق.`, ok: (n) => `إرسال إلى ${items(n)}` },
    { key: 'resend_setup', label: 'إعادة إرسال رابط الإعداد', title: 'إعادة إرسال رابط الإعداد',
      body: (n) => `يُرسل رابط تعيين كلمة المرور بالبريد لمن لم يعيّنها بعد من ${items(n)}. لا يُعرض الرابط هنا، ولا يُرسل مرتين خلال 10 دقائق.`, ok: (n) => `إرسال لـ ${items(n)}` });
  if (role === 'teacher') base.splice(1, 0,
    { key: 'approve', label: 'اعتماد', tone: 'primary', body: (n) => `سيظهر ${items(n)} للطلاب ويمكن حجز مواعيدهم.`, ok: (n) => `اعتماد ${items(n)}` },
    { key: 'unapprove', label: 'سحب الاعتماد', reason: true, body: (n) => `لن يظهر ${items(n)} للطلاب ولن تُقبل حجوزات جديدة. الحجوزات الحالية تبقى.`, ok: (n) => `سحب اعتماد ${items(n)}` });
  return base;
}

/* ---------------- Section ---------------- */
export default function PeopleLive({ role }: { role: A.Role }) {
  const L = ROLE_L[role];
  const { q, update } = useListUrl(L.sec);
  const [text, setText] = useUrlSearch(q, update);
  const sort = q.sort ?? '-joined';
  const page = Number(q.page ?? 1) || 1;
  const params = { ...listParams(q), role, sort, page: String(page) };
  const R = useServerList((p) => A.listPeople(p as Parameters<typeof A.listPeople>[0]), params);
  const [counts, setCounts] = useState<A.Counts | null>(null);
  const reloadCounts = useCallback(() => { A.peopleCounts(role).then(setCounts).catch(() => setCounts(null)); }, [role]);
  useEffect(() => { reloadCounts(); }, [reloadCounts]);
  const filter = filterOf(params);
  const sel = useSelection(JSON.stringify(filter));
  const [open, setOpen] = useState<number | null>(null); const [adding, setAdding] = useState(false);
  const reload = () => { void R.reload(); reloadCounts(); };

  const cur = q.unlinked === '1' ? 'unlinked' : q.status ?? 'all';
  const quick: [string, string, number | undefined][] = [
    ['all', 'الكل', counts?.all], ['pending', ST.pending.l, counts?.pending], ['active', ST.active.l, counts?.active], ['suspended', ST.suspended.l, counts?.suspended],
    ...(role === 'student' ? [['unlinked', 'دون معلم', counts?.unlinked] as [string, string, number | undefined]] : []),
    ['archived', ST.archived.l, counts?.archived],
  ];
  const rows = R.data?.results;
  const cols: Col<A.Person>[] = [
    { key: 'name', label: 'الاسم', sort: 'name', primary: true, cell: (u) => (
      <button onClick={() => setOpen(u.id)} style={{ border: 'none', background: 'transparent', padding: 0, font: 'inherit', fontWeight: 700, color: color.primary, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3, minHeight: 32, textAlign: 'right' }}>{u.full_name}</button>) },
    { key: 'email', label: 'البريد الإلكتروني', sort: 'email', cell: (u) => <bdi dir="ltr" style={{ fontFamily: font.latin }}>{u.email}</bdi> },
    { key: 'rel', label: role === 'student' ? 'المعلم' : role === 'teacher' ? 'الاعتماد' : 'الأبناء', cell: (u) => (
      role === 'student' ? (u.teachers.map((t) => t.name).join('، ') || <span style={{ color: color.danger }}>غير مرتبط</span>)
        : role === 'teacher' ? (u.approved ? 'معتمد' : <span style={{ color: color.danger }}>غير معتمد</span>)
          : (u.children.map((c) => c.name).join('، ') || '—')) },
    { key: 'joined', label: 'تاريخ الانضمام', sort: 'joined', cell: (u) => date(u.date_joined) },
    { key: 'last', label: 'آخر نشاط', sort: 'last_login', cell: (u) => date(u.last_login) },
    { key: 'status', label: 'الحالة', sort: 'status', cell: (u) => <Pill st={u.status} /> },
  ];

  return (
    <>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="search" aria-label={L.search} placeholder={L.search} value={text} onChange={(e) => setText(e.target.value)}
          style={{ flex: '1 1 240px', minHeight: 48, padding: '0 14px', borderRadius: 12, border: `1.5px solid ${color.borderInput}`, background: color.card, fontSize: 15 }} />
        <FilterControls fields={FIELDS[role]} q={q} update={update} />
        <ExportButton resource="users" sel={sel} total={R.data?.count ?? 0} filter={filter} sort={sort} />
        <button onClick={() => setAdding(true)} style={primaryBtn(48, 15, { padding: '0 16px', borderRadius: 12, gap: 6, marginInlineStart: 'auto' })}>
          <Icon name="plus" size={18} /> {role === 'teacher' ? 'دعوة معلم' : `إضافة ${L.one}`}
        </button>
      </div>
      <div role="group" aria-label="تصفية حسب الحالة" style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2 }}>
        {quick.map(([k, l, n]) => (
          <button key={k} aria-pressed={cur === k} onClick={() => update(k === 'unlinked' ? { status: '', unlinked: '1' } : { status: k === 'all' ? '' : k, unlinked: '' })} style={chip(cur === k)}>
            {l} {n !== undefined && <span style={{ fontFamily: font.latin, opacity: 0.75 }}>({n})</span>}
          </button>
        ))}
      </div>
      <SavedViews section={L.sec} q={q} update={update} presets={PRESETS[role]} />
      <SelectionSummary sel={sel} pageIds={rows?.map((r) => r.id) ?? []} total={R.data?.count ?? 0} />
      <DataView rows={rows} cols={cols} sel={sel} total={R.data?.count ?? 0} rowLabel={(u) => u.full_name} sort={sort}
        setSort={(s) => update({ sort: s })} loading={R.loading} err={R.err} retry={reload} />
      <Pager page={page} total={R.data?.count ?? 0} setPage={(p) => update({ page: String(p) })} />
      <BulkBar resource="users" sel={sel} total={R.data?.count ?? 0} actions={peopleActions(role)} filter={filter} onDone={reload} exportable />
      {open !== null && <PersonPanel id={open} onClose={() => setOpen(null)} onChanged={reload} />}
      {adding && <AddDialog role={role} onClose={() => setAdding(false)} onDone={reload} />}
    </>
  );
}

/* ---------------- Add / invite ---------------- */
function AddDialog({ role, onClose, onDone }: { role: A.Role; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', email: '', phone: '' });
  const [err, setErr] = useState<Record<string, string | null>>({}); const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ link: string | null; note: string; message?: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const x: Record<string, string> = {};
    if (role !== 'teacher' && f.name.trim().length < 2) x.name = 'اكتب الاسم الكامل.';
    if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) x.email = 'صيغة البريد الإلكتروني غير صحيحة.';
    if (Object.keys(x).length) return setErr(x);
    setBusy(true); setErr({});
    try {
      if (role === 'teacher') {
        const r = await A.inviteTeacher(f.email.trim().toLowerCase());
        setResult({ link: r.link, message: 'السلام عليكم، دعتك إدارة الحلقة للانضمام معلمًا. أنشئ حسابك من هذا الرابط (صالح 7 أيام ولمرة واحدة):',
          note: r.emailed ? `أُرسلت الدعوة تلقائيًا إلى ${f.email.trim()}. يمكنك أيضًا إرسالها عبر واتساب. صالحة 7 أيام ولمرة واحدة.`
            : 'تعذّر إرسال البريد الآن؛ أرسل الرابط عبر واتساب أو انسخه. صالح 7 أيام ولمرة واحدة، ويُنشئ حسابًا معتمدًا.' });
      } else {
        const r = await A.createPerson(f.name.trim(), f.email.trim().toLowerCase(), role);
        setResult(r.setup_email_sent ? { link: null, note: 'تم إنشاء الحساب وأُرسل رابط تعيين كلمة المرور إلى بريده.' }
          : { link: r.setup_link, message: 'السلام عليكم، أُنشئ حسابك في منصة الحلقة. عيّن كلمة المرور من هذا الرابط (صالح لمرة واحدة):',
              note: 'تم إنشاء الحساب. تعذّر إرسال البريد، فأرسل هذا الرابط عبر واتساب أو انسخه ليعيّن كلمة المرور (صالح لمرة واحدة).' });
      }
      onDone();
    } catch (y) {
      const a = y as ApiError;
      const fe = { name: a.field?.('full_name') ?? null, email: a.field?.('email') ?? null };
      setErr(fe.name || fe.email ? fe : { form: a.message });
    } finally { setBusy(false); }
  };
  return (
    <Modal title={role === 'teacher' ? 'دعوة معلم' : `إضافة ${ROLE_L[role].one}`} onClose={onClose}>
      {result ? (<>{result.link ? <LinkBox link={result.link} note={result.note} message={result.message} phone={f.phone} /> : <p role="status" style={{ margin: 0 }}>{result.note}</p>}
        <button onClick={onClose} style={primaryBtn(48, 15)}>تم</button></>) : (
        <form noValidate onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {role !== 'teacher' && <>
            <label htmlFor="ad-n" style={labelStyle}>الاسم الكامل</label>
            <input id="ad-n" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-invalid={!!err.name} style={inputStyle(err.name)} />
            <FieldError msg={err.name} />
          </>}
          <label htmlFor="ad-e" style={labelStyle}>البريد الإلكتروني</label>
          <input id="ad-e" type="email" dir="ltr" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} aria-invalid={!!err.email} style={inputStyle(err.email, true)} />
          <FieldError msg={err.email} />
          <label htmlFor="ad-p" style={labelStyle}>رقم واتساب (اختياري)</label>
          <input id="ad-p" type="tel" dir="ltr" inputMode="tel" placeholder="01xxxxxxxxx" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} style={inputStyle(null, true)} />
          <span style={{ fontSize: 12, color: color.muted }}>{role === 'teacher' ? 'تُرسل الدعوة إلى البريد تلقائيًا، ويمكنك إرسالها أيضًا عبر واتساب إلى هذا الرقم.' : 'يُرسل رابط تعيين كلمة المرور إلى البريد تلقائيًا.'}</span>
          {err.form && <FieldError msg={err.form} />}
          <button type="submit" disabled={busy} style={primaryBtn(48, 15)}>{busy ? 'جارٍ الحفظ…' : role === 'teacher' ? 'إرسال الدعوة' : 'إنشاء الحساب'}</button>
        </form>
      )}
    </Modal>
  );
}

/* ---------------- Detail panel ---------------- */
type Sub = { kind: 'reason'; title: string; body: string; ok: string; required?: boolean; run: (r: string) => Promise<unknown> } | { kind: 'pick'; target: A.Role } | null;

function PersonPanel({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const [u, setU] = useState<A.Person | null>(null); const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ full_name: string; phone: string } | null>(null); const [editErr, setEditErr] = useState<Record<string, string | null>>({});
  const [sub, setSub] = useState<Sub>(null); const [link, setLink] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => { try { setU(await A.getPerson(id)); setErr(null); } catch (e) { setErr(errMsg(e)); } }, [id]);
  useEffect(() => { void reload(); }, [reload]);

  /** Runs a write, then re-reads the person and the list from the server. */
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); await reload(); onChanged(); } catch (e) { toast(errMsg(e)); } finally { setBusy(false); }
  };
  const saveEdit = async (e: FormEvent) => {
    e.preventDefault(); if (!edit || !u) return;
    if (edit.full_name.trim().length < 2) return setEditErr({ full_name: 'اكتب الاسم الكامل.' });
    setBusy(true);
    try { setU(await A.updatePerson(u.id, { full_name: edit.full_name.trim(), phone: edit.phone.trim() })); setEdit(null); setEditErr({}); toast('حُفظت البيانات'); onChanged(); }
    catch (x) { const a = x as ApiError; setEditErr({ full_name: a.field?.('full_name') ?? null, phone: a.field?.('phone') ?? null, form: a.message }); }
    finally { setBusy(false); }
  };
  const reasonRun = (title: string, body: string, ok: string, done: string, run: (r: string) => Promise<unknown>, required = true) =>
    setSub({ kind: 'reason', title, body, ok, required, run: async (r) => { await run(r); toast(done); await reload(); onChanged(); } });

  const row = (label: string, value: ReactNode) => (
    <div style={{ display: 'flex', gap: 10, minHeight: 32, alignItems: 'baseline' }}><span style={{ minWidth: 120, color: color.muted, fontSize: 14 }}>{label}</span><span style={{ flex: 1, fontSize: 15 }}>{value}</span></div>
  );
  const section = (title: string, children: ReactNode) => (
    <section style={{ borderTop: `1px solid ${color.divider}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{title}</h3>{children}
    </section>
  );

  return (
    <Modal title={u ? u.full_name : 'تفاصيل الحساب'} onClose={onClose} wide>
      {err && <p role="alert" style={{ margin: 0, color: color.danger }}>{err}</p>}
      {!u && !err && <p role="status" style={{ margin: 0, color: color.muted }}>جارٍ التحميل…</p>}
      {u && <>
        {edit ? (
          <form noValidate onSubmit={saveEdit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label htmlFor="ed-n" style={labelStyle}>الاسم الكامل</label>
            <input id="ed-n" value={edit.full_name} onChange={(e) => setEdit({ ...edit, full_name: e.target.value })} style={inputStyle(editErr.full_name)} />
            <FieldError msg={editErr.full_name} />
            <label htmlFor="ed-p" style={labelStyle}>رقم الهاتف</label>
            <input id="ed-p" dir="ltr" inputMode="tel" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} style={inputStyle(editErr.phone, true)} />
            <FieldError msg={editErr.phone ?? (editErr.full_name ? null : editErr.form)} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" disabled={busy} style={{ ...smallBtn('primary'), minHeight: 44 }}>حفظ</button>
              <button type="button" onClick={() => { setEdit(null); setEditErr({}); }} style={{ ...smallBtn(), minHeight: 44 }}>إلغاء</button>
            </div>
          </form>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {row('الحالة', <Pill st={u.status} />)}
            {row('البريد', <bdi dir="ltr" style={{ fontFamily: font.latin }}>{u.email}</bdi>)}
            {row('الهاتف', u.phone ? <bdi dir="ltr">{u.phone}</bdi> : '—')}
            {u.role === 'student' && row('المستوى', u.level || '—')}
            {row('المنطقة الزمنية', <bdi dir="ltr">{u.timezone}</bdi>)}
            {row('انضم في', date(u.date_joined))}
            {row('آخر دخول', date(u.last_login))}
            {row('كلمة المرور', u.has_password ? 'معيّنة' : <span style={{ color: color.danger }}>لم تُعيَّن بعد</span>)}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
              <button onClick={() => setEdit({ full_name: u.full_name, phone: u.phone })} style={smallBtn()}>تعديل البيانات</button>
              {u.status !== 'suspended' && u.status !== 'archived' && <button disabled={busy} onClick={() => act(async () => setLink((await A.newSetupLink(u.id)).setup_link), 'تم إنشاء رابط تعيين كلمة المرور')} style={smallBtn()}>رابط تعيين كلمة المرور</button>}
            </div>
            {link && <LinkBox link={link} note="أرسل هذا الرابط إلى صاحب الحساب بنفسك. صالح لمرة واحدة؛ ولا تشاركه مع غيره." />}
          </div>
        )}

        {section('حالة الحساب', (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {u.status === 'pending' && <button disabled={busy} onClick={() => act(() => A.setPersonStatus(u.id, 'active'), 'تم اعتماد الحساب')} style={smallBtn('primary')}>اعتماد الحساب</button>}
            {(u.status === 'suspended' || u.status === 'archived') && <button disabled={busy} onClick={() => act(() => A.setPersonStatus(u.id, 'active'), 'أُعيد تفعيل الحساب')} style={smallBtn('primary')}>إعادة التفعيل</button>}
            {u.status !== 'archived' && <button disabled={busy} onClick={() => reasonRun('أرشفة الحساب', `لن يستطيع ${u.full_name} الدخول أو استعادة كلمة المرور. تبقى كل سجلاته محفوظة، ويمكن إعادة التفعيل لاحقًا.`, 'أرشفة الحساب', 'أُرشف الحساب', (r) => A.setPersonStatus(u.id, 'archived', r))} style={smallBtn('danger')}>أرشفة الحساب</button>}
            {u.status !== 'suspended' && u.status !== 'archived' && <button disabled={busy} onClick={() => reasonRun('إيقاف الحساب', `سيُمنع ${u.full_name} من الدخول فورًا حتى تعيد تفعيله.`, 'إيقاف الحساب', 'تم إيقاف الحساب', (r) => A.setPersonStatus(u.id, 'suspended', r))} style={smallBtn('danger')}>إيقاف الحساب</button>}
          </div>
        ))}

        {u.role === 'teacher' && section('الاعتماد', (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>{u.approved ? 'معتمد: يظهر للطلاب ويمكن حجز مواعيده.' : 'غير معتمد: لا يظهر للطلاب.'}</span>
            {u.approved
              ? <button disabled={busy} onClick={() => reasonRun('سحب اعتماد المعلم', 'لن يظهر المعلم للطلاب ولن تُقبل حجوزات جديدة معه. الحجوزات الحالية تبقى.', 'سحب الاعتماد', 'سُحب الاعتماد', (r) => A.setTeacherApproval(u.id, false, r))} style={smallBtn('danger')}>سحب الاعتماد</button>
              : <button disabled={busy} onClick={() => act(() => A.setTeacherApproval(u.id, true), 'تم اعتماد المعلم')} style={smallBtn('primary')}>اعتماد المعلم</button>}
          </div>
        ))}

        {u.role === 'student' && section('المعلمون', (<>
          {u.teachers.length === 0 && <p style={{ margin: 0, color: color.danger, fontSize: 14 }}>غير مرتبط بأي معلم.</p>}
          {u.teachers.map((t) => (
            <div key={t.assignment_id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span style={{ flex: 1 }}>{t.name}</span>
              <button disabled={busy} onClick={() => reasonRun('إنهاء الربط بالمعلم', `سيتوقف ${t.name} عن رؤية مهام ${u.full_name} وتسجيلاته الجديدة. السجل السابق يبقى.`, 'إنهاء الربط', 'أُنهي الربط', () => A.endAssignment(t.assignment_id), false)} aria-label={`إنهاء الربط بـ${t.name}`} style={smallBtn('danger')}>إنهاء الربط</button></div>
          ))}
          <button disabled={busy} onClick={() => setSub({ kind: 'pick', target: 'teacher' })} style={{ ...smallBtn(), alignSelf: 'flex-start' }}>ربط بمعلم</button>
        </>))}

        {u.role === 'student' && section('أولياء الأمور', (<>
          {u.guardians.length === 0 && <p style={{ margin: 0, color: color.muted, fontSize: 14 }}>لا يوجد ولي أمر مرتبط.</p>}
          {u.guardians.map((g) => (
            <div key={g.link_id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span style={{ flex: 1 }}>{g.name}</span>
              <button disabled={busy} onClick={() => reasonRun('فك ربط ولي الأمر', `لن يرى ${g.name} بيانات ${u.full_name} بعد الآن.`, 'فك الربط', 'فُكّ الربط', (r) => A.revokeGuardian(g.link_id, r))} aria-label={`فك ربط ${g.name}`} style={smallBtn('danger')}>فك الربط</button></div>
          ))}
          <button disabled={busy} onClick={() => setSub({ kind: 'pick', target: 'parent' })} style={{ ...smallBtn(), alignSelf: 'flex-start' }}>ربط بولي أمر</button>
        </>))}

        {u.role === 'parent' && section('الأبناء', (<>
          {u.children.length === 0 && <p style={{ margin: 0, color: color.muted, fontSize: 14 }}>لا يوجد أبناء مرتبطون.</p>}
          {u.children.map((c) => (
            <div key={c.link_id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span style={{ flex: 1 }}>{c.name}</span>
              <button disabled={busy} onClick={() => reasonRun('فك ربط الابن', `لن يرى ${u.full_name} بيانات ${c.name} بعد الآن.`, 'فك الربط', 'فُكّ الربط', (r) => A.revokeGuardian(c.link_id, r))} aria-label={`فك ربط ${c.name}`} style={smallBtn('danger')}>فك الربط</button></div>
          ))}
          <button disabled={busy} onClick={() => setSub({ kind: 'pick', target: 'student' })} style={{ ...smallBtn(), alignSelf: 'flex-start' }}>ربط بابن</button>
        </>))}
      </>}
      {sub?.kind === 'reason' && <ReasonDialog title={sub.title} body={sub.body} ok={sub.ok} required={sub.required} onClose={() => setSub(null)} run={async (r) => { await sub.run(r); }} />}
      {sub?.kind === 'pick' && u && (
        <PickDialog target={sub.target} exclude={sub.target === 'teacher' ? u.teachers.map((t) => t.id) : sub.target === 'parent' ? u.guardians.map((g) => g.id) : u.children.map((c) => c.id)}
          onClose={() => setSub(null)}
          onPick={async (other) => {
            if (sub.target === 'teacher') await A.assignTeacher(other.id, u.id);
            else if (sub.target === 'parent') await A.linkGuardian(other.id, u.id);
            else await A.linkGuardian(u.id, other.id);
            toast('تم الربط'); await reload(); onChanged();
          }} />
      )}
    </Modal>
  );
}

/** Search and choose an active account of `target` role. */
function PickDialog({ target, exclude, onClose, onPick }: { target: A.Role; exclude: number[]; onClose: () => void; onPick: (p: A.Person) => Promise<void> }) {
  const [q, setQ] = useState(''); const [rows, setRows] = useState<A.Person[] | null>(null);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      try { const p = await A.listPeople({ role: target, q: q.trim(), status: 'active', page_size: 20 }); if (live) { setRows(p.results); setErr(null); } }
      catch (e) { if (live) setErr(errMsg(e)); }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, target]);
  const pick = async (p: A.Person) => {
    setBusy(p.id); setErr(null);
    try { await onPick(p); onClose(); } catch (e) { setErr(errMsg(e)); setBusy(null); }
  };
  const label = target === 'teacher' ? 'اختر المعلم' : target === 'parent' ? 'اختر ولي الأمر' : 'اختر الطالب';
  return (
    <Modal title={label} onClose={onClose}>
      <input type="search" aria-label="بحث" placeholder="ابحث بالاسم أو البريد" value={q} onChange={(e) => setQ(e.target.value)} style={inputStyle(null)} />
      {err && <FieldError msg={err} />}
      {rows === null && !err && <p role="status" style={{ margin: 0, color: color.muted }}>جارٍ التحميل…</p>}
      {rows && rows.filter((r) => !exclude.includes(r.id)).length === 0 && <p style={{ margin: 0, color: color.muted }}>لا توجد حسابات نشطة مطابقة.</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows?.filter((r) => !exclude.includes(r.id)).map((r) => (
          <button key={r.id} disabled={busy !== null} onClick={() => void pick(r)} style={{ minHeight: 52, padding: '0 12px', borderRadius: 12, border: `1px solid ${color.divider}`, background: color.card, textAlign: 'right', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1 }}><span style={{ display: 'block', fontWeight: 700 }}>{r.full_name}</span><bdi dir="ltr" style={{ fontSize: 12, color: color.muted }}>{r.email}</bdi></span>
            {target === 'teacher' && !r.approved && <span style={{ fontSize: 12, color: color.danger }}>غير معتمد</span>}
            {busy === r.id && <span style={{ fontSize: 13, color: color.muted }}>جارٍ الربط…</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}
