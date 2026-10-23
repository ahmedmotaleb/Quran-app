/**
 * Live Students / Teachers / Parents sections: server-side search, status filter and pagination; a detail
 * panel whose every action is a server call. The screen only changes after the server confirms.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { color, font } from '@/theme/tokens';
import { FieldError, inputStyle, labelStyle, primaryBtn } from '@/components/ui';
import { Icon } from '@/components/Icon';
import type { ApiError } from '@/api/client';
import { can, toast, useAdmin } from '../adminStore';
import { SUR } from '@/data/demo';
import { zonedToIso } from '@/lib/time';
import { card } from '../AdminTables';
import * as A from './api';
import { chip, date, errMsg, LinkBox, Modal, ReasonDialog, smallBtn } from './ui';
import {
  BulkBar, type BulkDef, circleOptions, type Col, courseOptions, DataView, ExportButton, type FilterField, FilterControls, filterOf, items, accounts, listParams, Pager,
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
    { key: 'unexcused', label: 'غياب بدون عذر', type: 'select', options: [['1', 'غياب واحد'], ['2', 'غيابان'], ['3', '3 أو أكثر']] },
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
  student: [['طلاب على وشك الإيقاف', { unexcused: '2', status: 'active' }], ['طلاب بدون معلم', { unlinked: '1' }], ['مراجعات متأخرة', { overdue_review: '1' }], ['دون جلسة قادمة', { upcoming: '0', status: 'active' }], ['المؤرشفون', { status: 'archived' }]],
  teacher: [['معلمون دون مواعيد', { has_slots: '0', status: 'active' }], ['غير معتمدين', { approved: '0' }], ['دون طلاب', { has_students: '0' }]],
  parent: [['دون أبناء مرتبطين', { linked: '0' }], ['بانتظار الاعتماد', { status: 'pending' }]],
};

const publishedCircles = async (): Promise<[string, string][]> =>
  (await A.listCircles({ state: 'published', page_size: '100', sort: 'name' })).results.map((c) => [String(c.id), `${c.name} (${c.members ?? 0}/${c.capacity})`]);

function peopleActions(role: A.Role): BulkDef[] {
  const base: BulkDef[] = [
    { key: 'activate', label: 'تفعيل', tone: 'primary', reason: true, title: 'تفعيل الحسابات',
      body: (n) => `سيُفعَّل ${items(n)} ويستطيع أصحابها الدخول. اكتب السبب (مثل: تمت مراجعة حالة الطالب). سجل الغياب السابق لا يُمحى.`, ok: (n) => `تفعيل ${items(n)}` },
    { key: 'suspend', label: 'تعطيل', reason: true, title: 'تعطيل الحسابات', body: (n) => `سيُمنع أصحاب ${items(n)} من الدخول فورًا حتى إعادة التفعيل. لا يُحذف أي سجل.`, ok: (n) => `تعطيل ${items(n)}` },
    { key: 'archive', label: 'أرشفة', tone: 'danger', reason: true, destructive: true, title: 'تأكيد الأرشفة',
      body: (n) => `أنت على وشك أرشفة ${items(n)}. لن يستطيع أصحابها الدخول أو استعادة كلمة المرور. تبقى مهامهم وتقييماتهم وحضورهم محفوظة، ويمكن إعادة التفعيل لاحقًا.`, ok: (n) => `أرشفة ${items(n)}` },
    { key: 'delete', label: 'حذف نهائي', tone: 'danger', reason: true, destructive: true, confirmAlways: true, freshMfa: true, title: 'حذف نهائي',
      body: (n) => `أنت على وشك حذف ${accounts(n)} نهائيًا. لا يمكن التراجع عن هذا الإجراء. لا دخول بعد الآن، ويُمسح الاسم والبريد والهاتف والتسجيلات الصوتية. تبقى سجلات المعلمين باسم «حساب محذوف»، والحساب الذي لا نشاط له يُحذف بالكامل. المعلم الذي له جلسات قادمة لا يُحذف حتى تُلغى أو تُنقل. (للإيقاف القابل للتراجع استخدم «أرشفة».)`,
      ok: (n) => `حذف ${accounts(n)} نهائيًا` },
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
  const [invKey, setInvKey] = useState(0);
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
        : role === 'teacher' ? (u.approved ? 'معتمد' : <span style={{ color: color.danger }}>بانتظار الاعتماد</span>)
          : (u.children.map((c) => c.name).join('، ') || '—')) },
    { key: 'setup', label: 'إعداد الحساب', cell: (u) => (u.has_password ? 'تم إعداد الحساب'
      : <span style={{ color: color.dangerInk }}>لم يعيّن كلمة مرور · {u.setup_email_status === 'sent' ? 'تم إرسال رابط الإعداد' : u.setup_email_status === 'failed' ? 'فشل الإرسال' : 'لم يُرسل رابط'}</span>) },
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
        {can(role === 'teacher' ? 'invitations.send' : 'users.create') && <button onClick={() => setAdding(true)} style={primaryBtn(48, 15, { padding: '0 16px', borderRadius: 12, gap: 6, marginInlineStart: 'auto' })}>
          <Icon name="plus" size={18} /> {role === 'teacher' ? 'إضافة / دعوة معلم' : `إضافة ${L.one}`}
        </button>}
      </div>
      <div role="group" aria-label="تصفية حسب الحالة" style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2 }}>
        {quick.map(([k, l, n]) => (
          <button key={k} aria-pressed={cur === k} onClick={() => update(k === 'unlinked' ? { status: '', unlinked: '1' } : { status: k === 'all' ? '' : k, unlinked: '' })} style={chip(cur === k)}>
            {l} {n !== undefined && <span style={{ fontFamily: font.latin, opacity: 0.75 }}>({n})</span>}
          </button>
        ))}
      </div>
      {role === 'teacher' && can('invitations.send') && <InvitationsPanel reloadKey={invKey} />}
      {role === 'student' && <PendingExcusesPanel />}
      <SavedViews section={L.sec} q={q} update={update} presets={PRESETS[role]} />
      <SelectionSummary sel={sel} pageIds={rows?.map((r) => r.id) ?? []} total={R.data?.count ?? 0} />
      <DataView rows={rows} cols={cols} sel={sel} total={R.data?.count ?? 0} rowLabel={(u) => u.full_name} sort={sort}
        setSort={(s) => update({ sort: s })} loading={R.loading} err={R.err} retry={reload} />
      <Pager page={page} total={R.data?.count ?? 0} setPage={(p) => update({ page: String(p) })} />
      <BulkBar resource="users" sel={sel} total={R.data?.count ?? 0} actions={peopleActions(role)} filter={filter} onDone={reload} exportable />
      {open !== null && <PersonPanel id={open} onClose={() => setOpen(null)} onChanged={reload} />}
      {adding && <AddDialog role={role} onClose={() => setAdding(false)} onDone={() => { reload(); setInvKey((k) => k + 1); }} />}
    </>
  );
}

/* ---------------- Add / invite ---------------- */
/** After a setup email: what happened, retry when it failed, and (owner only, failed email only) copy the link. */
function SetupEmailResult({ id, email, sent, onRetried }: { id: number; email: string; sent: boolean; onRetried: (sent: boolean) => void }) {
  const [busy, setBusy] = useState(false); const [link, setLink] = useState<string | null>(null);
  const owner = useAdmin((st) => st.me?.admin_access?.level === 'owner');
  const retry = async () => {
    setBusy(true);
    try { const r = await A.newSetupLink(id); onRetried(r.setup_email_sent); toast(r.setup_email_sent ? `تم إرسال رابط الإعداد إلى ${email}` : 'تعذر إرسال البريد'); }
    catch (e) { toast(errMsg(e)); } finally { setBusy(false); }
  };
  const copy = async () => {
    setBusy(true);
    try { const r = await A.newSetupLink(id, true); setLink(r.setup_link); onRetried(r.setup_email_sent); } catch (e) { toast(errMsg(e)); } finally { setBusy(false); }
  };
  if (sent) return <p role="status" style={{ margin: 0, fontSize: 15, fontWeight: 700, color: color.primary }}>تم إرسال رابط الإعداد إلى <bdi dir="ltr">{email}</bdi></p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p role="alert" style={{ margin: 0, fontSize: 15, fontWeight: 700, color: color.dangerInk }}>تعذر إرسال البريد</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button disabled={busy} onClick={() => void retry()} style={smallBtn('primary')}>{busy ? 'جارٍ الإرسال…' : 'إعادة المحاولة'}</button>
        {owner && !link && <button disabled={busy} onClick={() => void copy()} style={smallBtn()}>نسخ رابط الإعداد</button>}
      </div>
      {link && <LinkBox link={link} note="رابط إعداد الحساب لمرة واحدة؛ أرسله لصاحب الحساب بنفسه ولا تشاركه مع غيره:" />}
    </div>
  );
}

function AddDialog({ role, onClose, onDone }: { role: A.Role; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', email: '' });
  const [err, setErr] = useState<Record<string, string | null>>({}); const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ id: number; sent: boolean } | null>(null);
  const [promote, setPromote] = useState<{ id: number; note: string } | null>(null); const [promoting, setPromoting] = useState(false);
  const [promoted, setPromoted] = useState(false);
  const email = f.email.trim().toLowerCase();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const x: Record<string, string> = {};
    if (f.name.trim().length < 2) x.name = 'اكتب الاسم الكامل.';
    if (!/^\S+@\S+\.\S+$/.test(email)) x.email = 'صيغة البريد الإلكتروني غير صحيحة.';
    if (Object.keys(x).length) return setErr(x);
    setBusy(true); setErr({});
    try {
      const r = role === 'teacher' ? await A.createTeacher(f.name.trim(), email) : await A.createPerson(f.name.trim(), email, role);
      setMade({ id: r.id, sent: r.setup_email_sent });
      onDone();
    } catch (y) {
      const a = y as ApiError;
      if (a.code === 'existing_student') setPromote({ id: Number(a.fields?.user?.[0]), note: a.message });
      else { const fe = { name: a.field?.('full_name') ?? null, email: a.field?.('email') ? a.message : null }; setErr(fe.name || fe.email ? fe : { form: a.message }); }
    } finally { setBusy(false); }
  };
  return (
    <Modal title={role === 'teacher' ? 'إضافة / دعوة معلم' : `إضافة ${ROLE_L[role].one}`} onClose={onClose}>
      {made ? (<>
        <p style={{ margin: 0, fontSize: 15 }}>{role === 'teacher' ? 'تم إنشاء حساب المعلم. يعيّن كلمة المرور من الرابط ثم يدخل من صفحة الدخول المعتادة، ويبقى «بانتظار الاعتماد» حتى تعتمده.' : 'تم إنشاء الحساب.'}</p>
        <SetupEmailResult id={made.id} email={email} sent={made.sent} onRetried={(sent) => setMade({ ...made, sent })} />
        <button onClick={onClose} style={primaryBtn(48, 15)}>تم</button></>)
      : promote ? (<>
        <p role="alert" style={{ margin: 0, fontSize: 15, fontWeight: 700, color: promoted ? color.primary : color.dangerInk }}>{promoted ? 'تمت ترقية الحساب إلى معلم. سيُطلب من المستخدم تسجيل الدخول من جديد.' : promote.note}</p>
        {!promoted && can('users.promote_teacher') && <button onClick={() => setPromoting(true)} style={smallBtn('primary')}>ترقية إلى معلم</button>}
        {promoting && <PromoteDialog id={promote.id} name={email} onClose={() => setPromoting(false)} onDone={() => { setPromoting(false); setPromoted(true); onDone(); }} />}
        <button onClick={onClose} style={primaryBtn(48, 15)}>تم</button></>)
      : (
        <form noValidate onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label htmlFor="ad-n" style={labelStyle}>الاسم الكامل</label>
          <input id="ad-n" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-invalid={!!err.name} style={inputStyle(err.name)} />
          <FieldError msg={err.name} />
          <label htmlFor="ad-e" style={labelStyle}>البريد الإلكتروني</label>
          <input id="ad-e" type="email" dir="ltr" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} aria-invalid={!!err.email} style={inputStyle(err.email, true)} />
          <FieldError msg={err.email} />
          <span style={{ fontSize: 12, color: color.muted }}>{role === 'teacher'
            ? 'يُنشأ حساب المعلم الآن، ويصله بريد «إعداد حساب المعلم في حَلْقة» لتعيين كلمة المرور. الاعتماد خطوة منفصلة.'
            : 'تُرسل حَلْقة رابط إعداد الحساب إلى هذا البريد مباشرة.'}</span>
          {err.form && <FieldError msg={err.form} />}
          <button type="submit" disabled={busy} style={primaryBtn(48, 15)}>{busy ? 'جارٍ الإنشاء…' : 'إنشاء الحساب وإرسال رابط الإعداد'}</button>
        </form>
      )}
    </Modal>
  );
}

const INV_ST: Record<A.Invitation['status'], [string, string]> = {
  pending: ['أُرسلت، بانتظار القبول', color.primary], failed: ['تعذّر الإرسال', color.dangerInk], expired: ['انتهت صلاحيتها', color.muted],
  accepted: ['قُبلت', color.primary], revoked: ['أُلغيت', color.muted],
};

/** Open teacher invitations (no codes): resend (new code, fresh expiry) or cancel. */
function InvitationsPanel({ reloadKey }: { reloadKey: number }) {
  const [rows, setRows] = useState<A.Invitation[] | null>(null); const [busy, setBusy] = useState<number | null>(null);
  const load = useCallback(() => { A.listInvitations('teacher_account').then((r) => setRows(r.results)).catch(() => setRows([])); }, []);
  useEffect(() => { load(); }, [load, reloadKey]);
  if (!rows?.length) return null;
  const run = async (id: number, fn: () => Promise<unknown>, ok: string) => {
    setBusy(id);
    try { await fn(); toast(ok); load(); } catch (e) { toast(errMsg(e)); } finally { setBusy(null); }
  };
  return (
    <details style={{ ...card, padding: '10px 14px' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 700, minHeight: 36 }}>دعوات قديمة مفتوحة من النظام السابق ({rows.length})</summary>
      {rows.map((r) => (
        <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', minHeight: 48, borderTop: `1px solid ${color.divider}` }}>
          <bdi dir="ltr" style={{ flex: '1 1 200px', fontFamily: font.latin }}>{r.email || '—'}</bdi>
          <span style={{ fontSize: 13, fontWeight: 700, color: INV_ST[r.status][1] }}>{INV_ST[r.status][0]}</span>
          <span style={{ fontSize: 12, color: color.muted }}>حتى {date(r.expires_at)}{r.send_count > 1 ? ` · أُرسلت ${r.send_count} مرات` : ''}</span>
          {r.email && <button disabled={busy === r.id} onClick={() => void run(r.id, () => A.resendInvitation(r.id), 'أُعيد إرسال الدعوة')} style={smallBtn('primary')}>إعادة إرسال الدعوة</button>}
          <button disabled={busy === r.id} onClick={() => void run(r.id, () => A.revokeInvitation(r.id), 'أُلغيت الدعوة')} style={smallBtn('danger')}>إلغاء</button>
        </div>
      ))}
    </details>
  );
}

/* ---------------- Detail panel ---------------- */
type Sub = { kind: 'reason'; title: string; body: string; ok: string; required?: boolean; typeWord?: string; otp?: boolean; run: (r: string, otp: string) => Promise<unknown> } | { kind: 'pick'; target: A.Role } | null;

function PersonPanel({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const [u, setU] = useState<A.Person | null>(null); const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ full_name: string; phone: string } | null>(null); const [editErr, setEditErr] = useState<Record<string, string | null>>({});
  const [sub, setSub] = useState<Sub>(null); const [setup, setSetup] = useState<boolean | null>(null); const [busy, setBusy] = useState(false);
  const [promote, setPromote] = useState(false); const [task, setTask] = useState(false);
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
    // The phone is sent only when it changed and may be edited (masked without users.view_contact; a verified
    // number is changed by its owner after verifying the new one).
    const phone = phoneEditable && edit.phone.trim() !== u.phone ? { phone: edit.phone.trim() } : {};
    try { setU(await A.updatePerson(u.id, { full_name: edit.full_name.trim(), ...phone })); setEdit(null); setEditErr({}); toast('حُفظت البيانات'); onChanged(); }
    catch (x) { const a = x as ApiError; setEditErr({ full_name: a.field?.('full_name') ?? null, phone: a.field?.('phone') ?? null, form: a.message }); }
    finally { setBusy(false); }
  };
  const phoneEditable = !!u && can('users.view_contact') && !u.phone_verified;
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
            <input id="ed-p" dir="ltr" inputMode="tel" value={edit.phone} disabled={!phoneEditable} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} style={inputStyle(editErr.phone, true)} />
            {!phoneEditable && <span style={{ fontSize: 12, color: color.muted }}>{u.phone_verified ? 'رقم مؤكد: يغيّره صاحب الحساب من «تأكيد رقم الهاتف».' : 'الرقم مخفي؛ تعديله يتطلب صلاحية عرض البريد والهاتف.'}</span>}
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
            {row('الهاتف', u.phone ? <><bdi dir="ltr">{u.phone}</bdi>{u.phone_verified && <span style={{ marginInlineStart: 8, fontSize: 12, fontWeight: 700, color: color.primary }}>مؤكد · يدخل به</span>}</> : '—')}
            {u.role === 'student' && row('المستوى', u.level || '—')}
            {row('المنطقة الزمنية', <bdi dir="ltr">{u.timezone}</bdi>)}
            {row('انضم في', date(u.date_joined))}
            {row('آخر دخول', date(u.last_login))}
            {row('إعداد الحساب', u.has_password ? 'تم إعداد الحساب' : <span style={{ color: color.danger, fontWeight: 700 }}>لم يُكمل إعداد الحساب (لم يعيّن كلمة مرور)</span>)}
            {!u.has_password && row('بريد الإعداد', u.setup_email_status === 'sent' ? 'تم الإرسال' : u.setup_email_status === 'failed'
              ? <span style={{ color: color.dangerInk, fontWeight: 700 }}>فشل الإرسال</span> : 'لم يُرسل بعد')}
            {!u.has_password && u.setup_email_count > 0 && row('آخر إرسال', <>{date(u.setup_email_last_at)} · عدد مرات الإرسال: <span style={{ fontFamily: font.latin }}>{u.setup_email_count}</span></>)}
            {u.role === 'teacher' && row('الاعتماد', u.approved ? 'معتمد' : <span style={{ color: color.dangerInk, fontWeight: 700 }}>بانتظار الاعتماد</span>)}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
              {can('users.edit') && <button onClick={() => setEdit({ full_name: u.full_name, phone: u.phone })} style={smallBtn()}>تعديل البيانات</button>}
              {can('invitations.send') && u.status !== 'suspended' && u.status !== 'archived' && <button disabled={busy}
                onClick={() => act(async () => { const r = await A.newSetupLink(u.id); setSetup(r.setup_email_sent); }, u.has_password ? 'أُرسل رابط تعيين كلمة المرور' : 'تمت محاولة إرسال رابط الإعداد')}
                style={smallBtn(u.has_password ? 'plain' : 'primary')}>{u.has_password ? 'إرسال رابط تعيين كلمة المرور' : 'إعادة إرسال رابط إعداد الحساب'}</button>}
            </div>
            {setup !== null && <SetupEmailResult id={u.id} email={u.email} sent={setup} onRetried={(ok) => { setSetup(ok); void reload(); }} />}
          </div>
        )}

        {u.role === 'student' && <DisciplineSection id={u.id} onChanged={() => { void reload(); onChanged(); }} />}
        {u.status_reason && <p style={{ margin: 0, fontSize: 14, background: u.status === 'suspended' ? color.dangerBg : color.sand, color: u.status === 'suspended' ? color.dangerInk : color.body, borderRadius: 12, padding: '8px 12px' }}>سبب الحالة: {u.status_reason}{u.status_changed_at ? ` · ${date(u.status_changed_at)}` : ''}</p>}
        {section('حالة الحساب', (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {can('users.suspend') && u.status === 'pending' && <button disabled={busy} onClick={() => act(() => A.setPersonStatus(u.id, 'active'), 'تم اعتماد الحساب')} style={smallBtn('primary')}>اعتماد الحساب</button>}
            {can('users.suspend') && (u.status === 'suspended' || u.status === 'archived') && <button disabled={busy} onClick={() => reasonRun('إعادة تفعيل الحساب', `سيستطيع ${u.full_name} الدخول من جديد. سجل الغياب السابق يبقى كما هو.`, 'إعادة التفعيل', 'أُعيد تفعيل الحساب', (r) => A.setPersonStatus(u.id, 'active', r))} style={smallBtn('primary')}>إعادة التفعيل</button>}
            {can('users.archive') && u.status !== 'archived' && <button disabled={busy} onClick={() => reasonRun('أرشفة الحساب', `لن يستطيع ${u.full_name} الدخول أو استعادة كلمة المرور. تبقى كل سجلاته محفوظة، ويمكن إعادة التفعيل لاحقًا.`, 'أرشفة الحساب', 'أُرشف الحساب', (r) => A.setPersonStatus(u.id, 'archived', r))} style={smallBtn('danger')}>أرشفة الحساب</button>}
            {can('assignments.manage') && u.role === 'student' && u.status === 'active' && <button disabled={busy} onClick={() => setTask(true)} style={smallBtn('primary')}>إضافة مهمة</button>}
            {can('users.promote_teacher') && u.role === 'student' && u.status !== 'archived' && <button disabled={busy} onClick={() => setPromote(true)} style={smallBtn()}>ترقية إلى معلم</button>}
            {can('users.delete_permanent') && <button disabled={busy} onClick={() => setSub({ kind: 'reason', title: 'حذف الحساب نهائيًا', typeWord: 'حذف', otp: true, ok: 'حذف نهائي',
              body: `سيُحذف حساب ${u.full_name} نهائيًا ولا يمكن التراجع: لن يستطيع الدخول أبدًا، ويُمسح الاسم والبريد والهاتف والتسجيلات الصوتية. تبقى سجلات المعلمين (المهام والتقييمات والحضور) باسم «حساب محذوف» حتى تبقى الإحصاءات صحيحة. إن لم يكن للحساب أي نشاط يُحذف بالكامل.`,
              run: async (r, otp) => {
                const res = await A.bulkAction('users', { action: 'delete', ids: [u.id], reason: r, confirm: 'حذف', ...(otp ? { otp } : {}) });
                if (res.success !== 1) throw new Error(res.errors[0]?.message ?? 'تعذّر الحذف.');
                toast('حُذف الحساب نهائيًا'); onChanged(); onClose();
              } })} style={smallBtn('danger')}>حذف نهائي</button>}
            {can('users.suspend') && u.status !== 'suspended' && u.status !== 'archived' && <button disabled={busy} onClick={() => reasonRun('إيقاف الحساب', `سيُمنع ${u.full_name} من الدخول فورًا حتى تعيد تفعيله.`, 'إيقاف الحساب', 'تم إيقاف الحساب', (r) => A.setPersonStatus(u.id, 'suspended', r))} style={smallBtn('danger')}>إيقاف الحساب</button>}
          </div>
        ))}

        {u.role === 'teacher' && section('الاعتماد', (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>{u.approved ? 'معتمد: يظهر للطلاب ويمكن حجز مواعيده.' : 'غير معتمد: لا يظهر للطلاب.'}</span>
            {!can('teachers.approve') ? null : u.approved
              ? <button disabled={busy} onClick={() => reasonRun('سحب اعتماد المعلم', 'لن يظهر المعلم للطلاب ولن تُقبل حجوزات جديدة معه. الحجوزات الحالية تبقى.', 'سحب الاعتماد', 'سُحب الاعتماد', (r) => A.setTeacherApproval(u.id, false, r))} style={smallBtn('danger')}>سحب الاعتماد</button>
              : <button disabled={busy} onClick={() => act(() => A.setTeacherApproval(u.id, true), 'تم اعتماد المعلم')} style={smallBtn('primary')}>اعتماد المعلم</button>}
          </div>
        ))}

        {u.role === 'student' && section('المعلمون', (<>
          {u.teachers.length === 0 && <p style={{ margin: 0, color: color.danger, fontSize: 14 }}>غير مرتبط بأي معلم.</p>}
          {u.teachers.map((t) => (
            <div key={t.assignment_id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span style={{ flex: 1 }}>{t.name}</span>
              {can('teachers.assign') && <button disabled={busy} onClick={() => reasonRun('إنهاء الربط بالمعلم', `سيتوقف ${t.name} عن رؤية مهام ${u.full_name} وتسجيلاته الجديدة. السجل السابق يبقى.`, 'إنهاء الربط', 'أُنهي الربط', () => A.endAssignment(t.assignment_id), false)} aria-label={`إنهاء الربط بـ${t.name}`} style={smallBtn('danger')}>إنهاء الربط</button>}</div>
          ))}
          {can('teachers.assign') && <button disabled={busy} onClick={() => setSub({ kind: 'pick', target: 'teacher' })} style={{ ...smallBtn(), alignSelf: 'flex-start' }}>ربط بمعلم</button>}
        </>))}

        {u.role === 'student' && section('أولياء الأمور', (<>
          {u.guardians.length === 0 && <p style={{ margin: 0, color: color.muted, fontSize: 14 }}>لا يوجد ولي أمر مرتبط.</p>}
          {u.guardians.map((g) => (
            <div key={g.link_id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span style={{ flex: 1 }}>{g.name}</span>
              {can('parents.link_child') && <button disabled={busy} onClick={() => reasonRun('فك ربط ولي الأمر', `لن يرى ${g.name} بيانات ${u.full_name} بعد الآن.`, 'فك الربط', 'فُكّ الربط', (r) => A.revokeGuardian(g.link_id, r))} aria-label={`فك ربط ${g.name}`} style={smallBtn('danger')}>فك الربط</button>}</div>
          ))}
          {can('parents.link_child') && <button disabled={busy} onClick={() => setSub({ kind: 'pick', target: 'parent' })} style={{ ...smallBtn(), alignSelf: 'flex-start' }}>ربط بولي أمر</button>}
        </>))}

        {u.role === 'parent' && section('الأبناء', (<>
          {u.children.length === 0 && <p style={{ margin: 0, color: color.muted, fontSize: 14 }}>لا يوجد أبناء مرتبطون.</p>}
          {u.children.map((c) => (
            <div key={c.link_id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span style={{ flex: 1 }}>{c.name}</span>
              {can('parents.link_child') && <button disabled={busy} onClick={() => reasonRun('فك ربط الابن', `لن يرى ${u.full_name} بيانات ${c.name} بعد الآن.`, 'فك الربط', 'فُكّ الربط', (r) => A.revokeGuardian(c.link_id, r))} aria-label={`فك ربط ${c.name}`} style={smallBtn('danger')}>فك الربط</button>}</div>
          ))}
          {can('parents.link_child') && <button disabled={busy} onClick={() => setSub({ kind: 'pick', target: 'student' })} style={{ ...smallBtn(), alignSelf: 'flex-start' }}>ربط بابن</button>}
        </>))}
      </>}
      {sub?.kind === 'reason' && <ReasonDialog title={sub.title} body={sub.body} ok={sub.ok} required={sub.required} typeWord={sub.typeWord} otp={sub.otp} onClose={() => setSub(null)} run={async (r, otp) => { await sub.run(r, otp); }} />}
      {task && u && <TaskDialog u={u} onClose={() => setTask(false)} />}
      {promote && u && <PromoteDialog id={u.id} name={u.full_name} onClose={() => setPromote(false)}
        onDone={() => { setPromote(false); toast('تمت ترقية الحساب إلى معلم. سيُطلب من المستخدم تسجيل الدخول من جديد.'); onChanged(); void reload(); }} />}
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
  const [newName, setNewName] = useState('');
  const typedEmail = /^\S+@\S+\.\S+$/.test(q.trim()) ? q.trim().toLowerCase() : '';
  /** No parent with this email yet: create the parent account (the setup link is emailed) and link it right away. */
  const createAndPick = async () => {
    if (newName.trim().length < 2) return setErr('اكتب اسم ولي الأمر.');
    setBusy(-1); setErr(null);
    try {
      const p = await A.createPerson(newName.trim(), typedEmail, 'parent');
      await onPick(p); toast(p.setup_email_sent ? 'أُنشئ حساب ولي الأمر وأُرسل رابط الإعداد إلى بريده' : 'أُنشئ حساب ولي الأمر؛ أرسل رابط الإعداد من صفحته'); onClose();
    } catch (e) { setErr(errMsg(e)); setBusy(null); }
  };
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
      <input type="search" aria-label="بحث" placeholder="ابحث بالاسم أو البريد أو رقم الهاتف" value={q} onChange={(e) => setQ(e.target.value)} style={inputStyle(null)} />
      {err && <FieldError msg={err} />}
      {rows === null && !err && <p role="status" style={{ margin: 0, color: color.muted }}>جارٍ التحميل…</p>}
      {rows && rows.filter((r) => !exclude.includes(r.id)).length === 0 && <p style={{ margin: 0, color: color.muted }}>لا توجد حسابات نشطة مطابقة.</p>}
      {target === 'parent' && typedEmail && rows?.length === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: `1px solid ${color.divider}`, paddingTop: 10 }}>
          <span style={{ fontSize: 14 }}>لا يوجد ولي أمر بالبريد <bdi dir="ltr">{typedEmail}</bdi>. أنشئ حسابه واربطه الآن:</span>
          <label htmlFor="pk-n" style={labelStyle}>اسم ولي الأمر</label>
          <input id="pk-n" value={newName} onChange={(e) => setNewName(e.target.value)} style={inputStyle(null)} />
          <button disabled={busy !== null} onClick={() => void createAndPick()} style={smallBtn('primary')}>{busy === -1 ? 'جارٍ الإنشاء…' : 'إنشاء حساب ولي الأمر وربطه'}</button>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows?.filter((r) => !exclude.includes(r.id)).map((r) => (
          <button key={r.id} disabled={busy !== null} onClick={() => void pick(r)} style={{ minHeight: 52, padding: '0 12px', borderRadius: 12, border: `1px solid ${color.divider}`, background: color.card, textAlign: 'right', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1 }}><span style={{ display: 'block', fontWeight: 700 }}>{r.full_name}</span><bdi dir="ltr" style={{ fontSize: 12, color: color.muted }}>{r.email}{r.phone ? ` · ${r.phone}` : ''}</bdi></span>
            {target === 'teacher' && !r.approved && <span style={{ fontSize: 12, color: color.danger }}>غير معتمد</span>}
            {busy === r.id && <span style={{ fontSize: 13, color: color.muted }}>جارٍ الربط…</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}

/** Student → Teacher, one account: same email, password and history. Reason, typed «ترقية», approval off by default. */
/** «إضافة مهمة» for a student (academic admins). The task belongs to one of the student's linked teachers, who reviews it. */
function TaskDialog({ u, onClose }: { u: A.Person; onClose: () => void }) {
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date(Date.now() + 86_400_000));
  const [f, setF] = useState({ teacher: u.teachers.length === 1 ? String(u.teachers[0].id) : '', kind: 'hifz', surah: '67', from: '', to: '', title: '',
    instructions: '', day: tomorrow, time: '21:00', rec: true });
  const [err, setErr] = useState<Record<string, string | null>>({}); const [busy, setBusy] = useState(false);
  const max = SUR[+f.surah][1];
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (busy) return;
    const x: Record<string, string> = {}; const a = parseInt(f.from, 10), b = parseInt(f.to, 10);
    if (!f.teacher) x.teacher = 'اختر المعلم المسؤول عن المهمة.';
    if (!a || a < 1 || a > max) x.from = `من 1 إلى ${max}.`;
    if (!b || b < 1 || b > max) x.to = `من 1 إلى ${max}.`; else if (a && b < a) x.to = 'يجب أن تكون النهاية بعد البداية.';
    if (Object.keys(x).length) return setErr(x);
    setBusy(true); setErr({});
    const name = SUR[+f.surah][0];
    try {
      await A.adminCreateTask({ student: u.id, teacher: Number(f.teacher), kind: f.kind, surah: +f.surah, ayah_from: a, ayah_to: b,
        title: f.title.trim() || `${{ hifz: 'حفظ', review: 'مراجعة', tajweed: 'تجويد:' }[f.kind]} سورة ${name}`,
        instructions: f.instructions.trim(), due_at: zonedToIso(f.day, f.time, 'Africa/Cairo'), requires_recording: f.rec });
      toast(`أُرسلت المهمة إلى ${u.full_name}`); onClose();
    } catch (y) {
      const a2 = y as ApiError;
      setErr({ teacher: a2.field?.('teacher') ?? null, from: a2.field?.('ayah_from') ?? null, to: a2.field?.('ayah_to') ?? null,
        form: a2.field?.('teacher') || a2.field?.('ayah_from') || a2.field?.('ayah_to') ? null : a2.message });
      setBusy(false);
    }
  };
  const field = (id: string, label: string, el: ReactNode, e?: string | null) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><label htmlFor={id} style={labelStyle}>{label}</label>{el}<FieldError msg={e} /></div>);
  return (
    <Modal title={`إضافة مهمة: ${u.full_name}`} onClose={() => { if (!busy) onClose(); }} wide>
      {u.teachers.length === 0 ? <><p role="alert" style={{ margin: 0, color: color.dangerInk, fontWeight: 700 }}>الطالب غير مرتبط بمعلم. اربطه بمعلم أولًا ليراجع تسليمه.</p>
        <button onClick={onClose} style={primaryBtn(48, 15)}>تم</button></> : (
      <form noValidate onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {field('tk-t', 'المعلم المسؤول (يراجع التسليم)', <select id="tk-t" value={f.teacher} onChange={(e) => setF({ ...f, teacher: e.target.value })} style={inputStyle(err.teacher)}>
          <option value="">اختر…</option>{u.teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>, err.teacher)}
        {field('tk-k', 'النوع', <select id="tk-k" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} style={inputStyle(null)}>
          <option value="hifz">حفظ</option><option value="review">مراجعة</option><option value="tajweed">تجويد</option></select>)}
        {field('tk-s', 'السورة', <select id="tk-s" value={f.surah} onChange={(e) => setF({ ...f, surah: e.target.value })} style={inputStyle(null)}>
          {Object.keys(SUR).map((k) => <option key={k} value={k}>{SUR[+k][0]} ({SUR[+k][1]} آية)</option>)}</select>)}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {field('tk-f', 'من الآية', <input id="tk-f" inputMode="numeric" dir="ltr" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} style={inputStyle(err.from, true)} />, err.from)}
          {field('tk-to', 'إلى الآية', <input id="tk-to" inputMode="numeric" dir="ltr" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} style={inputStyle(err.to, true)} />, err.to)}
        </div>
        {field('tk-ti', 'العنوان (اختياري)', <input id="tk-ti" maxLength={160} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} style={inputStyle(null)} />)}
        {field('tk-i', 'التوجيهات', <textarea id="tk-i" rows={3} value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} style={{ ...inputStyle(null), minHeight: 80, paddingTop: 10 }} />)}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {field('tk-d', 'موعد التسليم (بتوقيت القاهرة)', <input id="tk-d" type="date" dir="ltr" value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} style={inputStyle(null, true)} />)}
          {field('tk-h', 'الساعة', <input id="tk-h" type="time" dir="ltr" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} style={inputStyle(null, true)} />)}
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 40 }}><input type="checkbox" checked={f.rec} onChange={(e) => setF({ ...f, rec: e.target.checked })} style={{ width: 20, height: 20 }} /> يتطلب تسجيل تلاوة</label>
        <FieldError msg={err.form} />
        <button type="submit" disabled={busy} style={primaryBtn(48, 15)}>{busy ? 'جارٍ الإرسال…' : 'إرسال المهمة'}</button>
      </form>)}
    </Modal>
  );
}

function PromoteDialog({ id, name, onClose, onDone }: { id: number; name: string; onClose: () => void; onDone: (r: A.PromoteResult) => void }) {
  const [reason, setReason] = useState(''); const [typed, setTyped] = useState(''); const [approve, setApprove] = useState(false);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (reason.trim().length < 3) return setErr('اكتب سبب الترقية (3 أحرف على الأقل).');
    if (typed.trim() !== 'ترقية') return setErr('اكتب «ترقية» للتأكيد.');
    setBusy(true); setErr(null);
    try { onDone(await A.promoteTeacher(id, reason.trim(), approve)); } catch (x) { setErr(errMsg(x)); setBusy(false); }
  };
  return (
    <Modal title="ترقية الحساب إلى معلم" onClose={() => { if (!busy) onClose(); }}>
      <form noValidate onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.8 }}>سيتم تحويل هذا الحساب ({name}) من طالب إلى معلم مع الاحتفاظ بنفس البريد الإلكتروني وكلمة المرور وسجل الحساب السابق.</p>
        <p style={{ margin: 0, fontSize: 13, color: color.muted, lineHeight: 1.7 }}>ينتهي ارتباطه كطالب بالمعلمين والحلقات والدورات وأولياء الأمر، وتُلغى حجوزاته القادمة. تبقى تسليماته وتقييماته وحضوره كما هي. يُسجَّل خروجه من كل الأجهزة.</p>
        <label htmlFor="pr-r" style={labelStyle}>سبب الترقية</label>
        <textarea id="pr-r" rows={3} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} style={{ ...inputStyle(null), minHeight: 80, paddingTop: 10 }} />
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, minHeight: 40 }}>
          <input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} style={{ width: 20, height: 20 }} /> اعتماد المعلم مباشرة
        </label>
        <label htmlFor="pr-c" style={labelStyle}>اكتب ترقية للتأكيد</label>
        <input id="pr-c" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" style={inputStyle(null)} />
        <FieldError msg={err} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={onClose} disabled={busy} style={{ ...smallBtn(), minHeight: 48 }}>إلغاء</button>
          <button type="submit" disabled={busy} style={{ ...smallBtn('primary'), minHeight: 48, flex: 1 }}>{busy ? 'جارٍ الترقية…' : 'ترقية إلى معلم'}</button>
        </div>
      </form>
    </Modal>
  );
}

const EX_L: Record<string, string> = { pending: 'قيد المراجعة', approved: 'مقبول', rejected: 'مرفوض' };
const ATT_L: Record<string, string> = { absent: 'غائب', excused: 'غاب بعذر' };

/** «الانضباط والحضور»: the derived unexcused-absence count, the figures and each absence, with an audited
 *  «اعتماد العذر إداريًا» per absence (the teacher's original decision stays recorded). */
function DisciplineSection({ id, onChanged }: { id: number; onChanged: () => void }) {
  const [d, setD] = useState<A.Discipline | null>(null); const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const load = useCallback(async () => { try { setD(await A.discipline(id)); setErr(null); } catch (e) { setErr(errMsg(e)); } }, [id]);
  useEffect(() => { void load(); }, [load]);
  if (err) return <p role="alert" style={{ margin: 0, color: color.dangerInk }}>{err}</p>;
  if (!d) return null;
  const n = d.unexcused_absences;
  const head = n >= d.suspends_at ? `${n} — ${d.suspended ? 'الحساب موقوف' : 'تجاوز الحد'}` : `${n} / ${d.limit}`;
  return (
    <section aria-label="الانضباط والحضور" style={{ border: `1px solid ${n >= d.limit ? color.danger : color.divider}`, borderRadius: 14, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>الانضباط والحضور</h3>
      <p style={{ margin: 0, fontSize: 16, fontWeight: 800, color: n >= d.limit ? color.dangerInk : color.ink }}>الغياب بدون عذر: <span dir="ltr">{head}</span></p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 13, color: color.body }}>
        <span>الجلسات: {d.total_sessions}</span><span>حاضر: {d.present}</span><span>متأخر: {d.late}</span>
        <span>أعذار مقبولة: {d.approved_excuses}</span><span>أعذار معلقة: {d.pending_excuses}</span><span>أعذار مرفوضة: {d.rejected_excuses}</span>
      </div>
      {d.absences.map((a) => (
        <div key={a.booking} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${color.divider}`, paddingTop: 6, fontSize: 14 }}>
          <span style={{ flex: '1 1 200px' }}>{date(a.starts_at)} · {a.teacher} · {ATT_L[a.attendance] ?? a.attendance}{a.excuse ? ` · العذر: ${EX_L[a.excuse]}` : ''}</span>
          {a.counts && <span style={{ fontSize: 12, fontWeight: 700, color: color.dangerInk }}>يُحتسب</span>}
          {can('excuses.review') && a.excuse !== 'approved' && <button onClick={() => setOver(a.booking)} style={smallBtn()}>اعتماد العذر إداريًا</button>}
          {a.excuse === 'approved' && (a.makeup
            ? <span style={{ fontSize: 12, color: color.muted }}>جلسة تعويضية: {{ available: 'مُنحت', used: 'حُجزت', expired: 'انتهت', revoked: 'أُلغيت' }[a.makeup] ?? a.makeup}</span>
            : can('excuses.review') && <button onClick={() => void A.grantMakeup(a.booking).then(() => { toast('مُنحت جلسة تعويضية'); void load(); }).catch((e) => toast(errMsg(e)))} style={smallBtn('primary')}>منح جلسة تعويضية</button>)}
        </div>
      ))}
      {over !== null && <ReasonDialog title="اعتماد العذر إداريًا" body="تصحيح إداري مُسجَّل في سجل التدقيق: يُحتسب الغياب «بعذر»، ويبقى قرار المعلم الأصلي محفوظًا. إن أصبح الطالب الموقوف تلقائيًا دون الحد فراجع الحساب وأعد تفعيله يدويًا." ok="اعتماد العذر"
        onClose={() => setOver(null)} run={async (r) => { await A.excuseOverride(over, r); toast('اعتُمد العذر إداريًا'); await load(); onChanged(); }} />}
    </section>
  );
}

/** «طلبات الاعتذار» section: every pending excuse, the teacher who decides it, and the reason. Admins correct a decided
 *  absence from the student's record («اعتماد العذر إداريًا»). */
export function ExcusesLive() {
  const [rows, setRows] = useState<import('@/api/endpoints').ApiExcuseRow[] | null>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { A.adminExcuses().then((r) => setRows(r.results)).catch((e) => setErr(errMsg(e))); }, []);
  if (err) return <p role="alert" style={{ color: color.danger }}>{err}</p>;
  if (!rows) return <p role="status" style={{ color: color.muted }}>جارٍ التحميل…</p>;
  if (!rows.length) return <p style={{ ...card, padding: 18, margin: 0, color: color.muted }}>لا توجد طلبات اعتذار بانتظار قرار المعلم.</p>;
  return (
    <section style={{ ...card, padding: '10px 14px', display: 'flex', flexDirection: 'column' }}>
      <p style={{ margin: '4px 0 8px', fontSize: 14, color: color.muted }}>يقرر المعلم كل طلب. لتصحيح غياب بعد القرار افتح ملف الطالب ← الانضباط والحضور.</p>
      {rows.map((r) => (
        <div key={r.booking} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', minHeight: 48, alignItems: 'center', borderTop: `1px solid ${color.divider}`, fontSize: 14, padding: '6px 0' }}>
          <strong>{r.student.name}</strong><span>مع {r.teacher.name}</span><span style={{ color: color.muted }}>{date(r.starts_at)}</span>
          <span style={{ flex: '1 1 220px', color: color.body }}>{r.reason}</span>
        </div>
      ))}
    </section>
  );
}

/** «طلبات اعتذار معلقة»: excuses waiting for a teacher's decision (admins see them all; teachers decide). */
function PendingExcusesPanel() {
  const [rows, setRows] = useState<import('@/api/endpoints').ApiExcuseRow[] | null>(null);
  useEffect(() => { A.adminExcuses().then((r) => setRows(r.results)).catch(() => setRows([])); }, []);
  if (!rows?.length) return null;
  return (
    <details style={{ ...card, padding: '10px 14px' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 700, minHeight: 36 }}>طلبات اعتذار معلقة ({rows.length})</summary>
      {rows.map((r) => (
        <div key={r.booking} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', minHeight: 44, alignItems: 'center', borderTop: `1px solid ${color.divider}`, fontSize: 14 }}>
          <strong>{r.student.name}</strong><span>مع {r.teacher.name}</span><span style={{ color: color.muted }}>{date(r.starts_at)}</span>
          <span style={{ flex: '1 1 200px', color: color.body }}>{r.reason}</span>
        </div>
      ))}
    </details>
  );
}
