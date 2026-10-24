/** «الإدارة والصلاحيات»: who can do what in the portal. The server decides everything (admin_management.py): only
 *  `admins.manage`, never your own account, only owners touch owners, never more than you hold, always one active
 *  owner, and a current authenticator code for every change. This screen presents those rules. */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { color, font } from '@/theme/tokens';
import { FieldError, inputStyle, labelStyle, primaryBtn } from '@/components/ui';
import { Icon } from '@/components/Icon';
import type { ApiError } from '@/api/client';
import { card } from '../AdminTables';
import { needsFreshOtp, toast, useAdmin } from '../adminStore';
import * as A from './api';
import { date, errMsg, Modal, OtpField, ReasonDialog, smallBtn } from './ui';

const GROUPS: [string, string[]][] = [
  ['الأشخاص', ['users', 'teachers', 'parents']], ['الجدولة والحضور', ['bookings', 'sessions', 'circles', 'attendance', 'excuses']],
  ['التعلّم', ['assignments', 'submissions', 'feedback']], ['المحتوى', ['courses', 'lessons', 'quizzes']],
  ['التواصل', ['notifications', 'invitations']], ['التقارير', ['analytics', 'exports']], ['النظام', ['settings', 'audit', 'admins', 'security']],
];
const PRESET_ORDER = ['academic_manager', 'support', 'content', 'sessions', 'read_only', 'custom'];
const STATUS_L: Record<string, string> = { active: 'نشط', suspended: 'موقوف', pending: 'بانتظار', archived: 'مؤرشف' };

export default function AdminsLive() {
  const [d, setD] = useState<A.AdminsPage | null>(null); const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<{ edit: A.AdminRow | null; teacher?: { id: number; full_name: string } | null } | null>(null);
  const [status, setStatus] = useState<A.AdminRow | null>(null);
  const [acc, setAcc] = useState<{ row: A.AdminRow; action: 'suspend' | 'reactivate' | 'remove' } | null>(null);
  const meOwner = useAdmin((s) => s.me?.admin_access?.level === 'owner');
  const load = useCallback(async (alive: () => boolean = () => true) => {
    try { const x = await A.listAdmins(); if (alive()) { setD(x); setErr(null); } } catch (e) { if (alive()) setErr(errMsg(e)); }
  }, []);
  useEffect(() => { let on = true; void load(() => on); return () => { on = false; }; }, [load]);
  if (err) return <p role="alert" style={{ color: color.danger }}>{err} <button onClick={() => void load()} style={smallBtn('primary')}>إعادة المحاولة</button></p>;
  if (!d) return <p role="status" style={{ color: color.muted }}>جارٍ التحميل…</p>;
  const owners = d.results.filter((a) => a.level === 'owner' && a.status === 'active' && a.access_active).length;
  const mayTouch = (a: A.AdminRow) => !a.is_self && (a.level !== 'owner' || meOwner);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 980 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <p style={{ margin: 0, fontSize: 14, color: color.muted, flex: '1 1 320px' }}>
          كل مسؤول يرى ويفعل ما مُنح له فقط، والخادم يتحقق من كل طلب. التحقق بخطوتين إلزامي لكل مسؤول، وأي تغيير هنا يتطلب رمز التحقق الحالي ويُسجَّل في سجل التدقيق.
        </p>
        <button onClick={() => setForm({ edit: null, teacher: null })} style={{ ...smallBtn('primary'), minHeight: 48, padding: '0 16px', borderRadius: 12 }}>منح صلاحيات إدارة لمعلم</button>
        <button onClick={() => setForm({ edit: null })} style={primaryBtn(48, 15, { padding: '0 16px', borderRadius: 12, gap: 6 })}><Icon name="plus" size={18} /> إضافة مسؤول</button>
      </div>
      <div role="list" aria-label="المسؤولون" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {d.results.map((a) => (
          <div role="listitem" key={a.id} style={{ ...card, padding: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 260px', minWidth: 0 }}>
              <p style={{ margin: 0, fontWeight: 800, fontSize: 16 }}>{a.full_name}{a.is_self ? ' (أنت)' : ''}</p>
              <p style={{ margin: '2px 0 0', fontSize: 13, color: color.muted }}><bdi dir="ltr" style={{ fontFamily: font.latin }}>{a.email}</bdi>{a.phone ? <> · <bdi dir="ltr">{a.phone}</bdi></> : null}</p>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: color.muted }}>آخر دخول: {date(a.last_login)} · {a.mfa_enabled ? 'التحقق بخطوتين مفعّل' : <span style={{ color: color.dangerInk }}>لم يفعّل التحقق بخطوتين بعد</span>}</p>
            </div>
            <span style={{ fontSize: 13, fontWeight: 700, padding: '4px 10px', borderRadius: 999, border: `1px solid ${color.borderStrong}`, color: color.primary }}>{a.teacher_admin ? 'معلم + إدارة' : 'إدارة'}</span>
            <span style={{ fontSize: 13, fontWeight: 700, padding: '4px 10px', borderRadius: 999, background: a.level === 'owner' ? color.gold : color.sand, color: color.ink }}>
              {a.level === 'owner' ? 'المالك' : a.preset_label || 'دون صلاحيات'}{a.level !== 'owner' ? ` · ${a.permissions.length} صلاحية` : ''}
            </span>
            <span style={{ fontSize: 13, fontWeight: 700, color: a.status === 'active' && a.access_active ? color.primary : color.dangerInk }}>
              {!a.access_active ? 'صلاحيات الإدارة معطلة' : STATUS_L[a.status] ?? a.status}</span>
            {mayTouch(a) && a.teacher_admin && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={() => setForm({ edit: a })} aria-label={`تعديل صلاحيات ${a.full_name}`} style={smallBtn()}>تعديل الصلاحيات</button>
              {a.access_active
                ? <button disabled={a.level === 'owner' && owners <= 1} onClick={() => setAcc({ row: a, action: 'suspend' })} aria-label={`تعطيل صلاحيات الإدارة لـ${a.full_name}`} style={smallBtn('danger')}>تعطيل صلاحيات الإدارة</button>
                : <button onClick={() => setAcc({ row: a, action: 'reactivate' })} aria-label={`إعادة تفعيل صلاحيات الإدارة لـ${a.full_name}`} style={smallBtn('primary')}>إعادة تفعيل صلاحيات الإدارة</button>}
              <button disabled={a.level === 'owner' && a.access_active && owners <= 1} onClick={() => setAcc({ row: a, action: 'remove' })} aria-label={`إزالة صلاحيات الإدارة من ${a.full_name}`} style={smallBtn('danger')}>إزالة صلاحيات الإدارة</button>
            </div>}
            {mayTouch(a) && !a.teacher_admin && <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setForm({ edit: a })} aria-label={`تعديل صلاحيات ${a.full_name}`} style={smallBtn()}>تعديل الصلاحيات</button>
              {a.status === 'active'
                ? <button disabled={a.level === 'owner' && owners <= 1} title={a.level === 'owner' && owners <= 1 ? 'يجب أن يبقى مالك نشط واحد على الأقل' : undefined}
                    onClick={() => setStatus(a)} aria-label={`إيقاف ${a.full_name}`} style={smallBtn('danger')}>إيقاف</button>
                : <button onClick={() => setStatus(a)} aria-label={`إعادة تفعيل ${a.full_name}`} style={smallBtn('primary')}>إعادة التفعيل</button>}
            </div>}
          </div>
        ))}
      </div>
      {d.invitations.length > 0 && (
        <section style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>دعوات لم تُقبل بعد</h2>
          {d.invitations.map((i) => (
            <div key={i.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minHeight: 44, borderTop: `1px solid ${color.divider}` }}>
              <bdi dir="ltr" style={{ fontFamily: font.latin, flex: '1 1 200px' }}>{i.email}</bdi>
              <span style={{ fontSize: 13 }}>{i.level === 'owner' ? 'المالك' : d.preset_labels[i.preset] ?? i.preset}</span>
              <span style={{ fontSize: 13, color: i.status === 'pending' ? color.muted : color.dangerInk }}>{i.status === 'pending' ? `تنتهي ${date(i.expires_at)}` : i.status === 'expired' ? 'انتهت صلاحيتها' : 'تعذّر الإرسال'}</span>
              {i.status !== 'expired' && <button onClick={() => void A.resendInvitation(i.id).then((r) => { toast(r.email_sent ? 'أُعيد إرسال الدعوة' : 'تعذّر إرسال البريد'); void load(); }).catch((e) => toast(errMsg(e)))} style={smallBtn()}>إعادة الإرسال</button>}
              <button onClick={() => void A.revokeInvitation(i.id).then(() => { toast('أُلغيت الدعوة'); void load(); }).catch((e) => toast(errMsg(e)))} style={smallBtn('danger')}>إلغاء الدعوة</button>
            </div>
          ))}
        </section>
      )}
      {form && form.teacher !== undefined && <GrantTeacher page={d} meOwner={meOwner} initial={form.teacher} onClose={() => setForm(null)} onDone={(msg) => { setForm(null); toast(msg); void load(); }} />}
      {form && form.teacher === undefined && <AccessDialog page={d} edit={form.edit} meOwner={meOwner} onClose={() => setForm(null)} onDone={(msg) => { setForm(null); toast(msg); void load(); }}
        onTeacher={(t) => setForm({ edit: null, teacher: t })} />}
      {acc && <ReasonDialog otp required={acc.action !== 'reactivate'}
        title={acc.action === 'remove' ? 'إزالة صلاحيات الإدارة' : acc.action === 'suspend' ? 'تعطيل صلاحيات الإدارة' : 'إعادة تفعيل صلاحيات الإدارة'}
        body={acc.action === 'remove' ? `ستُزال صلاحيات الإدارة من ${acc.row.full_name} وتنتهي جلسته في لوحة الإدارة فورًا. يبقى حسابه كمعلم كما هو (طلابه وجلساته وبياناته).`
          : acc.action === 'suspend' ? `لن يستطيع ${acc.row.full_name} دخول لوحة الإدارة حتى تُعاد صلاحياته، وتنتهي جلسته فيها فورًا. حسابه كمعلم يعمل كالمعتاد.`
          : `سيستطيع ${acc.row.full_name} دخول لوحة الإدارة بالصلاحيات نفسها.`}
        ok={acc.action === 'remove' ? 'إزالة الصلاحيات' : acc.action === 'suspend' ? 'تعطيل الصلاحيات' : 'إعادة التفعيل'} onClose={() => setAcc(null)}
        run={async (r, otp) => {
          await A.teacherAccess(acc.row.id, acc.action, r, otp);
          toast(acc.action === 'remove' ? 'أُزيلت صلاحيات الإدارة؛ بقي حساب المعلم كما هو.' : acc.action === 'suspend' ? 'عُطّلت صلاحيات الإدارة' : 'أُعيد تفعيل صلاحيات الإدارة');
          void load();
        }} />}
      {status && <ReasonDialog otp title={status.status === 'active' ? 'إيقاف المسؤول' : 'إعادة تفعيل المسؤول'}
        body={status.status === 'active' ? `سيُمنع ${status.full_name} من دخول لوحة الإدارة فورًا وتُنهى جلساته. لا يُحذف أي سجل.` : `سيستطيع ${status.full_name} دخول لوحة الإدارة بالصلاحيات نفسها.`}
        ok={status.status === 'active' ? 'إيقاف' : 'إعادة التفعيل'} onClose={() => setStatus(null)}
        run={async (r, otp) => { await A.setAdminStatus(status.id, status.status === 'active' ? 'suspended' : 'active', r, otp); toast('حُفظ التغيير'); void load(); }} />}
    </div>
  );
}

function AccessDialog({ page, edit, meOwner, onClose, onDone, onTeacher }: {
  page: A.AdminsPage; edit: A.AdminRow | null; meOwner: boolean; onClose: () => void; onDone: (msg: string) => void;
  onTeacher: (t: { id: number; full_name: string }) => void;
}) {
  const [teacher, setTeacher] = useState<{ id: number; full_name: string } | null>(null);
  const mine = new Set(useAdmin((s) => s.me?.admin_access?.permissions ?? []));
  const [name, setName] = useState(''); const [email, setEmail] = useState('');
  const [level, setLevel] = useState<'owner' | 'admin'>(edit?.level === 'owner' ? 'owner' : 'admin');
  const [preset, setPreset] = useState(edit && edit.level !== 'owner' ? edit.preset || 'custom' : 'academic_manager');
  const [custom, setCustom] = useState<Set<string>>(new Set(edit?.permissions ?? page.presets.academic_manager ?? []));
  const [otp, setOtp] = useState(''); const [errs, setErrs] = useState<Record<string, string | null>>({}); const [busy, setBusy] = useState(false);
  const chosen = level === 'owner' ? Object.keys(page.permissions) : preset === 'custom' ? [...custom] : page.presets[preset] ?? [];
  const beyond = chosen.filter((p) => !mine.has(p));
  const withOtp = needsFreshOtp();

  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (busy) return;
    const fe: Record<string, string | null> = {};
    if (!edit && name.trim().length < 2) fe.full_name = 'اكتب اسم المسؤول.';
    if (!edit && !/^\S+@\S+\.\S+$/.test(email.trim())) fe.email = 'اكتب بريدًا إلكترونيًا صحيحًا.';
    if (level === 'admin' && chosen.length === 0) fe.permissions = 'اختر صلاحية واحدة على الأقل.';
    if (beyond.length) fe.permissions = 'لا يمكنك منح صلاحيات لا تملكها.';
    if (withOtp && !/^\d{6}$/.test(otp)) fe.otp = 'أدخل رمز التحقق المكوّن من 6 أرقام.';
    if (Object.values(fe).some(Boolean)) return setErrs(fe);
    setBusy(true); setErrs({});
    const access: A.AdminAccess = { level, preset: level === 'owner' ? 'owner' : preset, permissions: level === 'admin' && preset === 'custom' ? [...custom] : [] };
    try {
      if (edit) { await A.updateAdmin(edit.id, { ...access, otp }); onDone('حُفظت الصلاحيات؛ تُطبَّق من الطلب التالي.'); }
      else {
        const r = await A.inviteAdmin({ ...access, full_name: name.trim(), email: email.trim().toLowerCase(), otp });
        onDone(r.email_sent ? 'أُرسلت الدعوة إلى البريد (صالحة 3 أيام ولمرة واحدة).' : 'أُنشئت الدعوة لكن تعذّر إرسال البريد؛ أعد الإرسال من القائمة.');
      }
    } catch (x) {
      const a = x as ApiError;
      if (a.code === 'teacher_exists') { setTeacher({ id: Number(a.field?.('user')), full_name: a.field?.('full_name') ?? '' }); setErrs({ form: a.message }); setBusy(false); return; }
      setErrs({ email: a.field?.('email') ?? null, full_name: a.field?.('full_name') ?? null, otp: a.field?.('otp') ?? null,
        permissions: a.code === 'cannot_grant' ? a.message : a.field?.('permissions') ?? null,
        form: a.field?.('email') || a.field?.('otp') || a.code === 'cannot_grant' ? null : a.message });
      setBusy(false);
    }
  };
  const toggle = (p: string) => { const n = new Set(custom); n.has(p) ? n.delete(p) : n.add(p); setCustom(n); setPreset('custom'); };
  const usePreset = (k: string) => { setPreset(k); if (k !== 'custom') setCustom(new Set(page.presets[k] ?? [])); };

  return (
    <Modal title={edit ? `صلاحيات ${edit.full_name}` : 'إضافة مسؤول'} onClose={() => { if (!busy) onClose(); }} wide>
      <form noValidate onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!edit && <>
          <label htmlFor="ad-n" style={labelStyle}>الاسم</label>
          <input id="ad-n" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} style={inputStyle(errs.full_name)} />
          <FieldError msg={errs.full_name} />
          <label htmlFor="ad-e" style={labelStyle}>البريد الإلكتروني</label>
          <input id="ad-e" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle(errs.email, true)} />
          <span style={{ fontSize: 12, color: color.muted }}>تصل دعوة «دعوة للانضمام إلى إدارة حَلْقة» إلى هذا البريد فقط: رابط لمرة واحدة صالح 3 أيام، ثم يعيّن كلمة المرور ويفعّل التحقق بخطوتين.</span>
          <FieldError msg={errs.email} />
        </>}
        <fieldset style={{ border: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <legend style={{ ...labelStyle, marginBottom: 6 }}>مستوى الوصول</legend>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 40 }}><input type="radio" name="lvl" checked={level === 'admin'} onChange={() => setLevel('admin')} style={{ width: 20, height: 20 }} /> مسؤول بصلاحيات محددة</label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 40, opacity: meOwner ? 1 : 0.5 }}>
            <input type="radio" name="lvl" disabled={!meOwner} checked={level === 'owner'} onChange={() => setLevel('owner')} style={{ width: 20, height: 20 }} /> المالك (كل الصلاحيات، ومنها إدارة المسؤولين){meOwner ? '' : ' — للمالك فقط'}
          </label>
        </fieldset>
        {level === 'admin' && <>
          <label htmlFor="ad-p" style={labelStyle}>مجموعة الصلاحيات</label>
          <select id="ad-p" value={preset} onChange={(e) => usePreset(e.target.value)} style={inputStyle(null)}>
            {PRESET_ORDER.map((k) => <option key={k} value={k}>{page.preset_labels[k] ?? k}</option>)}
          </select>
          <details open={preset === 'custom'} style={{ border: `1px solid ${color.divider}`, borderRadius: 12, padding: '8px 12px' }}>
            <summary style={{ cursor: 'pointer', fontWeight: 700, minHeight: 36 }}>الصلاحيات ({chosen.length}) — عدّلها لتصبح «صلاحيات مخصصة»</summary>
            {GROUPS.map(([g, prefixes]) => {
              const ps = Object.keys(page.permissions).filter((p) => prefixes.includes(p.split('.')[0]));
              return (
                <fieldset key={g} style={{ border: 'none', padding: 0, margin: '8px 0 0' }}>
                  <legend style={{ fontSize: 14, fontWeight: 800, color: color.primary }}>{g}</legend>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 2 }}>
                    {ps.map((p) => (
                      <label key={p} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 36, fontSize: 14, opacity: mine.has(p) ? 1 : 0.5 }}>
                        <input type="checkbox" checked={chosen.includes(p)} disabled={!mine.has(p)} onChange={() => toggle(p)} style={{ width: 18, height: 18 }} />
                        {page.permissions[p]}
                      </label>
                    ))}
                  </div>
                </fieldset>
              );
            })}
          </details>
          <FieldError msg={errs.permissions} />
        </>}
        {withOtp && <><OtpField id="ad-otp" value={otp} onChange={setOtp} /><FieldError msg={errs.otp} /></>}
        <FieldError msg={errs.form} />
        {teacher && <button type="button" onClick={() => onTeacher(teacher)} style={{ ...smallBtn('primary'), minHeight: 44, alignSelf: 'flex-start' }}>منح صلاحيات إدارة</button>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" disabled={busy} style={{ ...smallBtn('primary'), minHeight: 48, flex: 1 }}>{busy ? 'جارٍ الحفظ…' : edit ? 'حفظ الصلاحيات' : 'إرسال الدعوة'}</button>
          <button type="button" onClick={onClose} disabled={busy} style={{ ...smallBtn(), minHeight: 48 }}>إلغاء</button>
        </div>
      </form>
    </Modal>
  );
}

/** «منح صلاحيات إدارة لمعلم»: an existing teacher keeps the same account (role «معلم», students, sessions, Google
 *  Calendar, sign-in) and gets admin access on top. Pick the teacher, the access, then confirm with the current code. */
function GrantTeacher({ page, meOwner, initial, onClose, onDone }: {
  page: A.AdminsPage; meOwner: boolean; initial: { id: number; full_name: string } | null; onClose: () => void; onDone: (msg: string) => void;
}) {
  const mine = new Set(useAdmin((s) => s.me?.admin_access?.permissions ?? []));
  const [q, setQ] = useState(''); const [found, setFound] = useState<A.TeacherCandidate[] | null>(null);
  const [teacher, setTeacher] = useState<{ id: number; full_name: string } | null>(initial);
  const [level, setLevel] = useState<'owner' | 'admin'>('admin');
  const [preset, setPreset] = useState('academic_manager');
  const [custom, setCustom] = useState<Set<string>>(new Set(page.presets.academic_manager ?? []));
  const [confirm, setConfirm] = useState(false);
  const [otp, setOtp] = useState(''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const chosen = level === 'owner' ? Object.keys(page.permissions) : preset === 'custom' ? [...custom] : page.presets[preset] ?? [];
  const withOtp = needsFreshOtp();
  useEffect(() => {
    if (teacher) return;
    let on = true;
    const t = setTimeout(() => { A.teacherCandidates(q.trim()).then((r) => { if (on) setFound(r.results); }).catch((e) => { if (on) setErr(errMsg(e)); }); }, 250);
    return () => { on = false; clearTimeout(t); };
  }, [q, teacher]);
  const label = level === 'owner' ? 'المالك' : page.preset_labels[preset] ?? preset;

  const next = (e: FormEvent) => {
    e.preventDefault();
    if (!teacher) return setErr('اختر المعلم.');
    if (level === 'admin' && !chosen.length) return setErr('اختر صلاحية واحدة على الأقل.');
    if (chosen.some((p) => !mine.has(p))) return setErr('لا يمكنك منح صلاحيات لا تملكها.');
    setErr(null); setConfirm(true);
  };
  const run = async (e: FormEvent) => {
    e.preventDefault(); if (busy || !teacher) return;
    if (withOtp && !/^\d{6}$/.test(otp)) return setErr('أدخل رمز التحقق المكوّن من 6 أرقام.');
    setBusy(true); setErr(null);
    try {
      await A.grantTeacherAccess({ teacher: teacher.id, level, preset: level === 'owner' ? 'owner' : preset, permissions: level === 'admin' && preset === 'custom' ? [...custom] : [], otp });
      onDone(`مُنح ${teacher.full_name} صلاحيات الإدارة مع الاحتفاظ بحسابه كمعلم.`);
    } catch (x) { setErr(errMsg(x)); setBusy(false); }
  };

  if (confirm && teacher) return (
    <Modal title="منح صلاحيات إدارة" onClose={() => { if (!busy) onClose(); }}>
      <form noValidate onSubmit={run} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, fontSize: 15 }}>سيحصل {teacher.full_name} على صلاحيات «{label}» في لوحة الإدارة مع الاحتفاظ بحسابه كمعلم وطلابه وجلساته وبياناته. يدخل لوحة الإدارة بالبريد وكلمة المرور نفسيهما، ويُطلب منه تفعيل التحقق بخطوتين عند أول دخول.</p>
        {withOtp && <OtpField id="gt-otp" value={otp} onChange={setOtp} />}
        <FieldError msg={err} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" disabled={busy} style={{ ...smallBtn('primary'), minHeight: 48, flex: 1 }}>{busy ? 'جارٍ التنفيذ…' : 'منح صلاحيات الإدارة'}</button>
          <button type="button" disabled={busy} onClick={() => setConfirm(false)} style={{ ...smallBtn(), minHeight: 48 }}>رجوع</button>
        </div>
      </form>
    </Modal>
  );
  return (
    <Modal title="منح صلاحيات إدارة لمعلم" onClose={onClose} wide>
      <form noValidate onSubmit={next} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {teacher ? <p style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          المعلم: <strong>{teacher.full_name}</strong>
          <button type="button" onClick={() => { setTeacher(null); setFound(null); }} style={smallBtn()}>تغيير</button></p> : <>
          <label htmlFor="gt-q" style={labelStyle}>ابحث عن المعلم بالاسم أو البريد أو الهاتف</label>
          <input id="gt-q" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" style={inputStyle(null)} />
          <div role="listbox" aria-label="المعلمون" style={{ display: 'flex', flexDirection: 'column', maxHeight: 220, overflowY: 'auto' }}>
            {found === null ? <span style={{ fontSize: 13, color: color.muted }}>جارٍ البحث…</span>
              : !found.length ? <span style={{ fontSize: 13, color: color.muted }}>لا يوجد معلم مطابق دون صلاحيات إدارة.</span>
              : found.map((t) => <button type="button" role="option" aria-selected={false} key={t.id} onClick={() => setTeacher(t)}
                  style={{ minHeight: 48, textAlign: 'right', border: 'none', borderTop: `1px solid ${color.divider}`, background: 'transparent', cursor: 'pointer', fontSize: 14, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <strong>{t.full_name}</strong><bdi dir="ltr" style={{ fontFamily: font.latin, color: color.muted }}>{t.email}</bdi>{t.phone && <bdi dir="ltr" style={{ color: color.muted }}>{t.phone}</bdi>}
                </button>)}
          </div>
        </>}
        <fieldset style={{ border: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <legend style={{ ...labelStyle, marginBottom: 6 }}>مستوى الوصول</legend>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 40 }}><input type="radio" name="gt-l" checked={level === 'admin'} onChange={() => setLevel('admin')} style={{ width: 20, height: 20 }} /> مسؤول بصلاحيات محددة</label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 40, opacity: meOwner ? 1 : 0.5 }}><input type="radio" name="gt-l" disabled={!meOwner} checked={level === 'owner'} onChange={() => setLevel('owner')} style={{ width: 20, height: 20 }} /> المالك{meOwner ? '' : ' — للمالك فقط'}</label>
        </fieldset>
        {level === 'admin' && <>
          <label htmlFor="gt-p" style={labelStyle}>مجموعة الصلاحيات</label>
          <select id="gt-p" value={preset} onChange={(e) => { setPreset(e.target.value); if (e.target.value !== 'custom') setCustom(new Set(page.presets[e.target.value] ?? [])); }} style={inputStyle(null)}>
            {PRESET_ORDER.map((k) => <option key={k} value={k}>{page.preset_labels[k] ?? k}</option>)}
          </select>
          {preset === 'custom' && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 2 }}>
            {Object.keys(page.permissions).map((p) => <label key={p} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 36, fontSize: 14, opacity: mine.has(p) ? 1 : 0.5 }}>
              <input type="checkbox" checked={custom.has(p)} disabled={!mine.has(p)} onChange={() => { const n = new Set(custom); n.has(p) ? n.delete(p) : n.add(p); setCustom(n); }} style={{ width: 18, height: 18 }} />{page.permissions[p]}</label>)}
          </div>}
        </>}
        <FieldError msg={err} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" style={{ ...smallBtn('primary'), minHeight: 48, flex: 1 }}>متابعة</button>
          <button type="button" onClick={onClose} style={{ ...smallBtn(), minHeight: 48 }}>إلغاء</button>
        </div>
      </form>
    </Modal>
  );
}
