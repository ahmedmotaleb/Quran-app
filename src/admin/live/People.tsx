/**
 * Live Students / Teachers / Parents sections: server-side search, status filter and pagination; a detail
 * panel whose every action is a server call. The screen only changes after the server confirms.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { color, font } from '@/theme/tokens';
import { FieldError, inputStyle, labelStyle, primaryBtn } from '@/components/ui';
import { Icon } from '@/components/Icon';
import type { ApiError } from '@/api/client';
import { card } from '../AdminTables';
import { toast } from '../adminStore';
import * as A from './api';
import { chip, date, errMsg, LinkBox, Modal, ReasonDialog, smallBtn } from './ui';

const PAGE = 20;
const ROLE_L: Record<A.Role, { one: string; many: string; search: string }> = {
  student: { one: 'طالب', many: 'الطلاب', search: 'ابحث بالاسم أو البريد' },
  teacher: { one: 'معلم', many: 'المعلمون', search: 'ابحث عن معلم بالاسم أو البريد' },
  parent: { one: 'ولي أمر', many: 'أولياء الأمور', search: 'ابحث عن ولي أمر بالاسم أو البريد' },
};
const ST: Record<A.AccountStatus, { l: string; bg: string; fg: string }> = {
  active: { l: 'نشط', bg: '#D8E5D7', fg: '#124C46' },
  pending: { l: 'بانتظار الاعتماد', bg: '#F3E6CC', fg: '#6B470C' },
  suspended: { l: 'موقوف', bg: '#F5E1DC', fg: '#8E2F20' },
};

function Pill({ st }: { st: A.AccountStatus }) {
  const t = ST[st];
  return <span style={{ display: 'inline-block', padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700, background: t.bg, color: t.fg, whiteSpace: 'nowrap' }}>{t.l}</span>;
}

/* ---------------- Section ---------------- */
export default function PeopleLive({ role }: { role: A.Role }) {
  const [q, setQ] = useState(''); const [dq, setDq] = useState('');
  const [f, setF] = useState<string>('all'); const [page, setPage] = useState(1);
  const [data, setData] = useState<{ rows: A.Person[]; total: number } | null>(null);
  const [counts, setCounts] = useState<A.Counts | null>(null);
  const [err, setErr] = useState<string | null>(null); const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<number | null>(null); const [adding, setAdding] = useState(false);
  const seq = useRef(0);

  useEffect(() => { const t = setTimeout(() => { setDq(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const load = useCallback(async () => {
    const my = ++seq.current; setLoading(true); setErr(null);
    try {
      const status = ['pending', 'active', 'suspended'].includes(f) ? f : undefined;
      const [p, c] = await Promise.all([
        A.listPeople({ role, q: dq, status, page, page_size: PAGE, unlinked: f === 'unlinked' ? '1' : undefined }), A.peopleCounts(role)]);
      if (my !== seq.current) return; // a newer request superseded this one
      setData({ rows: p.results, total: p.count }); setCounts(c);
    } catch (e) { if (my === seq.current) setErr(errMsg(e)); } finally { if (my === seq.current) setLoading(false); }
  }, [role, dq, f, page]);
  useEffect(() => { void load(); }, [load]);

  const filters: [string, string, number | undefined][] = [
    ['all', 'الكل', counts?.all], ['pending', ST.pending.l, counts?.pending], ['active', ST.active.l, counts?.active], ['suspended', ST.suspended.l, counts?.suspended],
    ...(role === 'student' ? [['unlinked', 'دون معلم', counts?.unlinked] as [string, string, number | undefined]] : []),
  ];
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE));
  const L = ROLE_L[role];

  return (
    <>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="search" aria-label={L.search} placeholder={L.search} value={q} onChange={(e) => setQ(e.target.value)}
          style={{ flex: '1 1 240px', minHeight: 48, padding: '0 14px', borderRadius: 12, border: `1.5px solid ${color.borderInput}`, background: color.card, fontSize: 15 }} />
        <button onClick={() => setAdding(true)} style={primaryBtn(48, 15, { padding: '0 16px', borderRadius: 12, gap: 6, marginInlineStart: 'auto' })}>
          <Icon name="plus" size={18} /> {role === 'teacher' ? 'دعوة معلم' : `إضافة ${L.one}`}
        </button>
      </div>
      <div role="group" aria-label="تصفية حسب الحالة" style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2 }}>
        {filters.map(([k, l, n]) => (
          <button key={k} aria-pressed={f === k} onClick={() => { setF(k); setPage(1); }} style={chip(f === k)}>
            {l} {n !== undefined && <span style={{ fontFamily: font.latin, opacity: 0.75 }}>({n})</span>}
          </button>
        ))}
      </div>
      <div style={{ ...card, overflowX: 'auto' }} aria-busy={loading}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, minWidth: 720 }}>
          <thead>
            <tr style={{ background: color.sand, textAlign: 'right' }}>
              {['الاسم', 'البريد الإلكتروني', role === 'student' ? 'المعلم' : role === 'teacher' ? 'الاعتماد' : 'الأبناء', 'تاريخ الانضمام', 'الحالة'].map((c) =>
                <th key={c} scope="col" style={{ padding: '12px 16px', fontWeight: 700, color: color.body, whiteSpace: 'nowrap' }}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((u) => (
              <tr key={u.id} style={{ borderTop: `1px solid ${color.divider}` }}>
                <th scope="row" style={{ padding: '12px 16px', textAlign: 'right' }}>
                  <button onClick={() => setOpen(u.id)} style={{ border: 'none', background: 'transparent', padding: 0, font: 'inherit', fontWeight: 700, color: color.primary, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3, minHeight: 32, textAlign: 'right' }}>{u.full_name}</button>
                </th>
                <td style={{ padding: '12px 16px', color: color.body }}><bdi dir="ltr" style={{ fontFamily: font.latin }}>{u.email}</bdi></td>
                <td style={{ padding: '12px 16px', color: color.body }}>
                  {role === 'student' ? (u.teachers.map((t) => t.name).join('، ') || <span style={{ color: color.danger }}>غير مرتبط</span>)
                    : role === 'teacher' ? (u.approved ? 'معتمد' : <span style={{ color: color.danger }}>غير معتمد</span>)
                      : (u.children.map((c) => c.name).join('، ') || '—')}
                </td>
                <td style={{ padding: '12px 16px', color: color.body }}>{date(u.date_joined)}</td>
                <td style={{ padding: '12px 16px' }}><Pill st={u.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && !data && <p role="status" style={{ margin: 0, padding: 28, textAlign: 'center', color: color.muted }}>جارٍ التحميل…</p>}
        {err && (
          <div role="alert" style={{ padding: 20, display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
            <span style={{ color: color.danger }}>{err}</span><button onClick={() => void load()} style={smallBtn('primary')}>إعادة المحاولة</button>
          </div>
        )}
        {!err && data && data.rows.length === 0 && <p style={{ margin: 0, padding: 28, textAlign: 'center', color: color.muted }}>لا توجد نتائج مطابقة.</p>}
      </div>
      {data && data.total > 0 && (
        <nav aria-label="الصفحات" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <p style={{ margin: 0, fontSize: 14, color: color.muted }}>عرض {(page - 1) * PAGE + 1}–{Math.min(page * PAGE, data.total)} من {data.total}</p>
          {pages > 1 && <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button disabled={page === 1} onClick={() => setPage(page - 1)} aria-label="الصفحة السابقة" style={smallBtn()}><Icon name="chevR" size={18} /></button>
            <span style={{ fontFamily: font.latin, minWidth: 64, textAlign: 'center' }}>{page} / {pages}</span>
            <button disabled={page === pages} onClick={() => setPage(page + 1)} aria-label="الصفحة التالية" style={smallBtn()}><Icon name="chevL" size={18} /></button>
          </div>}
        </nav>
      )}
      {open !== null && <PersonPanel id={open} onClose={() => setOpen(null)} onChanged={() => void load()} />}
      {adding && <AddDialog role={role} onClose={() => setAdding(false)} onDone={() => void load()} />}
    </>
  );
}

/* ---------------- Add / invite ---------------- */
function AddDialog({ role, onClose, onDone }: { role: A.Role; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', email: '' });
  const [err, setErr] = useState<Record<string, string | null>>({}); const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ link: string | null; note: string } | null>(null);
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
        setResult({ link: r.link, note: 'أرسل هذا الرابط إلى المعلم بنفسك (واتساب أو بريد). صالح 7 أيام ولمرة واحدة، ويُنشئ حسابًا معتمدًا.' });
      } else {
        const r = await A.createPerson(f.name.trim(), f.email.trim().toLowerCase(), role);
        setResult(r.setup_email_sent ? { link: null, note: 'تم إنشاء الحساب وأُرسل رابط تعيين كلمة المرور إلى بريده.' }
          : { link: r.setup_link, note: 'تم إنشاء الحساب. البريد غير مفعّل على الخادم بعد، فأرسل هذا الرابط بنفسك ليعيّن كلمة المرور (صالح لمرة واحدة).' });
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
      {result ? (<>{result.link ? <LinkBox link={result.link} note={result.note} /> : <p role="status" style={{ margin: 0 }}>{result.note}</p>}
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
          {err.form && <FieldError msg={err.form} />}
          <button type="submit" disabled={busy} style={primaryBtn(48, 15)}>{busy ? 'جارٍ الحفظ…' : role === 'teacher' ? 'إنشاء رابط الدعوة' : 'إنشاء الحساب'}</button>
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
              {u.status !== 'suspended' && <button disabled={busy} onClick={() => act(async () => setLink((await A.newSetupLink(u.id)).setup_link), 'تم إنشاء رابط تعيين كلمة المرور')} style={smallBtn()}>رابط تعيين كلمة المرور</button>}
            </div>
            {link && <LinkBox link={link} note="أرسل هذا الرابط إلى صاحب الحساب بنفسك. صالح لمرة واحدة؛ ولا تشاركه مع غيره." />}
          </div>
        )}

        {section('حالة الحساب', (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {u.status === 'pending' && <button disabled={busy} onClick={() => act(() => A.setPersonStatus(u.id, 'active'), 'تم اعتماد الحساب')} style={smallBtn('primary')}>اعتماد الحساب</button>}
            {u.status === 'suspended' && <button disabled={busy} onClick={() => act(() => A.setPersonStatus(u.id, 'active'), 'أُعيد تفعيل الحساب')} style={smallBtn('primary')}>إعادة التفعيل</button>}
            {u.status !== 'suspended' && <button disabled={busy} onClick={() => reasonRun('إيقاف الحساب', `سيُمنع ${u.full_name} من الدخول فورًا حتى تعيد تفعيله.`, 'إيقاف الحساب', 'تم إيقاف الحساب', (r) => A.setPersonStatus(u.id, 'suspended', r))} style={smallBtn('danger')}>إيقاف الحساب</button>}
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
