/** Live platform settings (pack prompt 08): a draft form separate from the saved server state, sensitive changes
 * confirmed with the admin's password, and the audit log of every admin change. */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { color, font } from '@/theme/tokens';
import { FieldError, Switch, inputStyle, labelStyle, primaryBtn } from '@/components/ui';
import type { ApiError } from '@/api/client';
import { card } from '../AdminTables';
import { toast, can } from '../adminStore';
import * as A from './api';
import { dateTime, errMsg, Modal, Pager, smallBtn, Table, usePaged } from './ui';

type Draft = Omit<A.Settings, 'updated_at' | 'sensitive'>;
const NUM: [keyof Draft, string, string, number, number][] = [
  ['cancel_hours', 'نافذة إلغاء المعلم', 'ساعة قبل الموعد', 0, 168],
  ['excuse_deadline_minutes', 'آخر موعد لطلب الاعتذار', 'دقيقة قبل بدء الجلسة', 0, 10080], ['join_minutes', 'فتح الدخول للجلسة', 'دقيقة قبل البداية', 0, 60],
  ['booking_lead_minutes', 'أقرب حجز ممكن', 'دقيقة من الآن', 0, 10080], ['booking_horizon_days', 'أبعد حجز ممكن', 'يومًا', 1, 90],
  ['individual_minutes', 'مدة الجلسة الفردية', 'دقيقة', 10, 240], ['group_minutes', 'مدة الحلقة الجماعية', 'دقيقة', 10, 240],
  ['max_recording_seconds', 'أقصى مدة للتسجيل', 'ثانية (الحد الأعلى للخادم 1200)', 30, 3600], ['max_upload_mb', 'أقصى حجم للتسجيل', 'ميغابايت (الحد الأعلى للخادم 25)', 1, 100],
];
/** Waiting list and make-up sessions (PROMPT 44). */
const NUM_WAIT: [keyof Draft, string, string, number, number][] = [
  ['waitlist_offer_hours', 'مهلة عرض المقعد من قائمة الانتظار', 'ساعة', 1, 72], ['makeup_expiry_days', 'صلاحية الجلسة التعويضية', 'يومًا', 1, 90],
];
const LABEL: Record<string, string> = Object.fromEntries([...NUM.map(([k, l]) => [k, l]), ...NUM_WAIT.map(([k, l]) => [k, l]), ['org_name', 'اسم الجهة'], ['support_email', 'بريد الدعم'],
  ['support_whatsapp', 'واتساب الدعم'], ['show_support_button', 'زر الدعم'], ['default_timezone', 'المنطقة الزمنية'], ['open_signup', 'التسجيل المفتوح'],
  ['session_reminders', 'تذكير الجلسات'], ['parent_weekly_report', 'تقرير أولياء الأمور'], ['makeup_enabled', 'الجلسات التعويضية'],
  ['makeup_granters', 'من يمنح الجلسة التعويضية']]);

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}><h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{title}</h2>{children}</section>;
}

/** Sections shown follow the admin's permissions (the server refuses the rest): settings.view / settings.manage,
 *  audit.view; every admin manages their own trusted devices. */
export default function SettingsLive() {
  if (!can('settings.view')) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 820 }}><TrustedDevices />{can('audit.view') && <AuditLog />}</div>
  );
  return <SettingsForm />;
}

function SettingsForm() {
  const [saved, setSaved] = useState<A.Settings | null>(null); const [v, setV] = useState<Draft | null>(null);
  const [err, setErr] = useState<Record<string, string | null>>({}); const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [askPw, setAskPw] = useState(false); const [auditKey, setAuditKey] = useState(0);
  // `alive` drops the answer of a request whose effect was already cleaned up (React runs mount effects twice in
  // development): a late duplicate answer used to overwrite what the admin had just typed.
  const load = useCallback(async (alive: () => boolean = () => true) => {
    try { const s = await A.getSettings(); if (!alive()) return; setSaved(s); setV(strip(s)); setLoadErr(null); }
    catch (e) { if (alive()) setLoadErr(errMsg(e)); }
  }, []);
  useEffect(() => { let on = true; void load(() => on); return () => { on = false; }; }, [load]);
  if (loadErr) return <p role="alert" style={{ color: color.danger }}>{loadErr} <button onClick={() => void load()} style={smallBtn('primary')}>إعادة المحاولة</button></p>;
  if (!saved || !v) return <p role="status" style={{ color: color.muted }}>جارٍ التحميل…</p>;

  const changed = (Object.keys(v) as (keyof Draft)[]).filter((k) => JSON.stringify(v[k]) !== JSON.stringify((saved as unknown as Draft)[k]));
  const sensitive = changed.filter((k) => saved.sensitive.includes(k));
  const up = (o: Partial<Draft>) => { setV({ ...v, ...o }); setErr({}); };
  const submit = async (pw?: string) => {
    const e: Record<string, string> = {};
    if (v.org_name.trim().length < 2) e.org_name = 'أدخل اسم الجهة';
    if (!/^\S+@\S+\.\S+$/.test(v.support_email.trim())) e.support_email = 'صيغة البريد الإلكتروني غير صحيحة';
    for (const [k, , , min, max] of [...NUM, ...NUM_WAIT]) { const n = v[k] as number; if (!Number.isInteger(n) || n < min || n > max) e[k] = `أدخل رقمًا بين ${min} و ${max}`; }
    if (Object.keys(e).length) { setErr(e); return; }
    if (sensitive.length && pw === undefined) { setAskPw(true); return; }
    setBusy(true);
    try {
      const patch: Partial<A.Settings> & { current_password?: string } = Object.fromEntries(changed.map((k) => [k, v[k]]));
      if (pw) patch.current_password = pw;
      const s = await A.saveSettings(patch); setSaved(s); setV(strip(s)); setAskPw(false); setAuditKey((x) => x + 1);
      toast('حُفظت الإعدادات');
    } catch (x) {
      const a = x as ApiError;
      if (a.code === 'reauth_required') { setAskPw(true); throw a; }
      const fe: Record<string, string | null> = {}; for (const k of Object.keys(v)) fe[k] = a.field?.(k) ?? null;
      setErr({ ...fe, form: Object.values(fe).some(Boolean) ? null : a.message });
    } finally { setBusy(false); }
  };
  const text = (k: 'org_name' | 'support_email' | 'support_whatsapp' | 'default_timezone', ltr = false) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label htmlFor={'st-' + k} style={labelStyle}>{LABEL[k]}{saved.sensitive.includes(k) ? ' (حساس)' : ''}</label>
      <input id={'st-' + k} dir={ltr ? 'ltr' : undefined} value={v[k]} aria-invalid={!!err[k]} onChange={(e) => up({ [k]: e.target.value })} style={inputStyle(err[k], ltr)} />
      <FieldError msg={err[k]} />
    </div>
  );
  const sw = (k: 'open_signup' | 'session_reminders' | 'parent_weekly_report' | 'show_support_button' | 'makeup_enabled', hint: string) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, minHeight: 52, borderTop: `1px solid ${color.divider}`, paddingTop: 12 }}>
      <span><span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{LABEL[k]}{saved.sensitive.includes(k) ? ' (حساس)' : ''}</span><span style={{ display: 'block', fontSize: 13, color: color.muted, marginTop: 2 }}>{hint}</span></span>
      <Switch on={v[k]} label={LABEL[k]} onToggle={() => up({ [k]: !v[k] })} />
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 820 }}>
      <Group title="الجهة والدعم">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 14 }}>
          {text('org_name')}{text('support_email', true)}{text('support_whatsapp', true)}{text('default_timezone', true)}
        </div>
        {sw('show_support_button', 'يظهر زر التواصل مع الدعم في تطبيق الطلاب')}
      </Group>
      <Group title="الحجز والجلسات">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14 }}>
          {NUM.slice(0, 6).map(([k, l, unit]) => <Num key={k} k={k} label={l} unit={unit} v={v} up={up} err={err[k]} sensitive={saved.sensitive.includes(k)} />)}
        </div>
      </Group>
      <Group title="قائمة الانتظار والجلسات التعويضية">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14 }}>
          {NUM_WAIT.map(([k, l, unit]) => <Num key={k} k={k} label={l} unit={unit} v={v} up={up} err={err[k]} sensitive={saved.sensitive.includes(k)} />)}
        </div>
        {sw('makeup_enabled', 'بعد قبول عذر الغياب يمكن منح الطالب جلسة بديلة واحدة مع المعلم نفسه')}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="st-makeup_granters" style={labelStyle}>{LABEL.makeup_granters}</label>
          <select id="st-makeup_granters" value={v.makeup_granters} onChange={(e) => up({ makeup_granters: e.target.value as Draft['makeup_granters'] })} style={inputStyle(err.makeup_granters)}>
            <option value="teachers_admins">المعلمون والإدارة</option><option value="admins">الإدارة فقط</option>
          </select>
          <FieldError msg={err.makeup_granters} />
        </div>
      </Group>
      <Group title="التسجيلات والحسابات">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14 }}>
          {NUM.slice(6).map(([k, l, unit]) => <Num key={k} k={k} label={l} unit={unit} v={v} up={up} err={err[k]} sensitive={saved.sensitive.includes(k)} />)}
        </div>
        <Intervals v={v.review_intervals} onChange={(x) => up({ review_intervals: x })} err={err.review_intervals} />
        {sw('open_signup', 'يسمح لأي شخص بإنشاء حساب طالب من التطبيق')}
        {sw('session_reminders', 'تذكير الطالب والمعلم قبل الجلسة (يُفعَّل عند ربط الإشعارات)')}
        {sw('parent_weekly_report', 'ملخص أسبوعي داخل التطبيق لكل ولي أمر مساء الجمعة (بتوقيت القاهرة)')}
      </Group>
      {err.form && <FieldError msg={err.form} />}
      {can('settings.manage') && <div style={{ position: 'sticky', bottom: 0, background: color.ivory, padding: '12px 0', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${color.divider}` }}>
        <button onClick={() => void submit().catch(() => {})} disabled={busy || !changed.length} style={primaryBtn(48, 15, { padding: '0 22px' })}>{busy ? 'جارٍ الحفظ…' : 'حفظ التغييرات'}</button>
        <button onClick={() => { setV(strip(saved)); setErr({}); }} disabled={!changed.length} style={smallBtn()}>تراجع</button>
        <span style={{ fontSize: 13, color: color.muted }}>{changed.length ? `${changed.length} تغيير غير محفوظ${sensitive.length ? ' (يتطلب كلمة المرور)' : ''}` : `آخر حفظ: ${dateTime(saved.updated_at)}`}</span>
      </div>}
      {askPw && <PasswordDialog fields={sensitive.map((k) => LABEL[k])} onClose={() => setAskPw(false)} run={(pw) => submit(pw)} />}
      <TrustedDevices />
      {can('audit.view') && <AuditLog key={auditKey} />}
    </div>
  );
}

/** Spaced-repetition intervals as a comma-separated list of days; empty = the defaults (1, 3, 7, 14, 30). */
function Intervals({ v, onChange, err }: { v: number[]; onChange: (x: number[]) => void; err?: string | null }) {
  const [txt, setTxt] = useState(v.join('، '));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label htmlFor="st-review_intervals" style={labelStyle}>فواصل المراجعة المتباعدة (بالأيام)</label>
      <input id="st-review_intervals" dir="ltr" value={txt} placeholder="1, 3, 7, 14, 30" aria-invalid={!!err}
        onChange={(e) => { setTxt(e.target.value); onChange(e.target.value.split(/[,،\s]+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n))); }}
        style={inputStyle(err, true, { maxWidth: 320 })} />
      <span style={{ fontSize: 12, color: color.muted, lineHeight: 1.6 }}>بعد اعتماد حفظ مقطع تُجدول مراجعته بعد الفاصل الأول، ثم ينتقل للتالي عند الإتقان (كل الدرجات 4+)، ويتكرر عند الدرجة 3، ويعود لفاصل أقصر عند الإعادة أو الدرجة 2 أو أقل. اتركه فارغًا للقيم الافتراضية.</span>
      <FieldError msg={err} />
    </div>
  );
}

const strip = (s: A.Settings): Draft => { const { updated_at: _u, sensitive: _s, ...d } = s; return d; };

function Num({ k, label, unit, v, up, err, sensitive }: { k: keyof Draft; label: string; unit: string; v: Draft; up: (o: Partial<Draft>) => void; err?: string | null; sensitive: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label htmlFor={'st-' + k} style={labelStyle}>{label}{sensitive ? ' (حساس)' : ''}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input id={'st-' + k} inputMode="numeric" dir="ltr" value={String(v[k])} aria-invalid={!!err}
          onChange={(e) => up({ [k]: e.target.value === '' ? NaN : Number(e.target.value.replace(/\D/g, '')) } as Partial<Draft>)}
          style={inputStyle(err, true, { width: 110, textAlign: 'center' })} />
        <span style={{ fontSize: 13, color: color.muted }}>{unit}</span>
      </div>
      <FieldError msg={err} />
    </div>
  );
}

function PasswordDialog({ fields, onClose, run }: { fields: string[]; onClose: () => void; run: (pw: string) => Promise<void> }) {
  const [pw, setPw] = useState(''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!pw) return setErr('أدخل كلمة المرور.');
    setBusy(true); setErr(null);
    try { await run(pw); } catch (x) { setErr((x as ApiError).field?.('current_password') ?? errMsg(x)); setPw(''); } finally { setBusy(false); }
  };
  return (
    <Modal title="تأكيد بكلمة المرور" onClose={onClose}>
      <form noValidate onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p style={{ margin: 0 }}>تغيير هذه الإعدادات حساس: {fields.join('، ')}. أدخل كلمة مرور حسابك للتأكيد.</p>
        <label htmlFor="st-pw" style={labelStyle}>كلمة المرور</label>
        <input id="st-pw" type="password" dir="ltr" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} style={inputStyle(err, true)} />
        <FieldError msg={err} />
        <button type="submit" disabled={busy} style={primaryBtn(48, 15)}>{busy ? 'جارٍ الحفظ…' : 'تأكيد وحفظ'}</button>
      </form>
    </Modal>
  );
}

const ACTION_L: Record<string, string> = {
  'admin.settings_changed': 'تعديل الإعدادات', 'admin.settings_reauth_failed': 'محاولة تعديل حساس دون تأكيد', 'admin.user_status': 'تغيير حالة حساب',
  'admin.user_updated': 'تعديل بيانات حساب', 'admin.user_created': 'إنشاء حساب', 'admin.setup_link_issued': 'رابط تعيين كلمة مرور',
  'admin.teacher_approval': 'اعتماد معلم', 'admin.teacher_assigned': 'ربط طالب بمعلم', 'admin.teacher_unassigned': 'إنهاء ربط معلم',
  'admin.guardian_linked': 'ربط ولي أمر', 'admin.guardian_revoked': 'فك ربط ولي أمر', 'admin.circle_created': 'إنشاء حلقة', 'admin.circle_state': 'حالة حلقة',
  'admin.circle_sessions': 'جدولة جلسات', 'admin.session_cancelled': 'إلغاء جلسة', 'admin.booking_cancelled': 'إلغاء حجز', 'admin.course_created': 'إنشاء دورة',
  'admin.course_state': 'حالة دورة', 'admin.lesson_created': 'إنشاء درس', 'admin.lesson_state': 'حالة درس', 'admin.enrolled': 'تسجيل طالب في دورة',
  'admin.enrollment_ended': 'إنهاء تسجيل', 'admin.test_created': 'إنشاء اختبار', 'admin.test_state': 'حالة اختبار', 'admin.question_versioned': 'نسخة جديدة لسؤال',
  'auth.mfa_trusted_device': 'دخول من جهاز موثوق', 'auth.device_trusted': 'توثيق جهاز', 'auth.devices_untrusted': 'إزالة أجهزة موثوقة',
  'auth.login': 'تسجيل دخول', 'auth.login_failed': 'دخول فاشل', 'auth.mfa_failed': 'رمز تحقق خاطئ', 'auth.mfa_enabled': 'تفعيل التحقق بخطوتين',
};

/** Browsers where this admin ticked «تذكّر هذا الجهاز»: the two-step code is not asked there until the trust ends. */
export function TrustedDevices() {
  const [rows, setRows] = useState<A.TrustedDevice[] | null>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setRows((await A.listTrustedDevices()).results); setErr(null); } catch (e) { setErr(errMsg(e)); } }, []);
  useEffect(() => { void load(); }, [load]);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); try { await fn(); toast(ok); await load(); } catch (e) { toast(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Group title="الأجهزة الموثوقة">
      <p style={{ margin: 0, fontSize: 14, color: color.muted }}>على هذه الأجهزة يكفي البريد وكلمة المرور لدخول الإدارة، دون رمز التحقق، لمدة 30 يومًا. تنتهي الثقة تلقائيًا عند تغيير كلمة المرور أو تطبيق المصادقة.</p>
      {err && <p role="alert" style={{ margin: 0, color: color.danger }}>{err}</p>}
      {rows === null && !err && <p role="status" style={{ margin: 0, color: color.muted }}>جارٍ التحميل…</p>}
      {rows?.length === 0 && <p style={{ margin: 0, fontSize: 14 }}>لا توجد أجهزة موثوقة. فعّل «تذكّر هذا الجهاز» عند إدخال الرمز.</p>}
      {rows?.map((d) => (
        <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', borderTop: `1px solid ${color.divider}`, paddingTop: 10 }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 700 }}>{d.label}
              {d.current && <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, background: color.primary, color: color.ivory }}>هذا الجهاز</span>}</span>
            <span style={{ display: 'block', fontSize: 13, color: color.muted }}>أُضيف: {dateTime(d.created_at)} · آخر استخدام: {d.last_used_at ? dateTime(d.last_used_at) : '—'} · تنتهي: {dateTime(d.expires_at)}</span>
          </span>
          <button disabled={busy} onClick={() => void run(() => A.revokeTrustedDevice(d.id), 'أُلغيت الثقة بهذا الجهاز؛ سيُطلب رمز التحقق عليه في الدخول القادم')} aria-label={`إلغاء الثقة: ${d.label}`} style={smallBtn('danger')}>إلغاء الثقة</button>
        </div>
      ))}
      {!!rows?.length && <button disabled={busy} onClick={() => void run(A.revokeAllTrustedDevices, 'أُلغيت الثقة من كل الأجهزة')} style={{ ...smallBtn('danger'), alignSelf: 'flex-start' }}>إلغاء الثقة من كل الأجهزة</button>}
    </Group>
  );
}

function AuditLog() {
  const [f, setF] = useState('admin.');
  const L = usePaged((page) => A.listAudit({ action: f || undefined, page }), [f]);
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, flex: 1 }}>سجل التغييرات</h2>
        <select aria-label="نوع الأحداث" value={f} onChange={(e) => setF(e.target.value)} style={{ ...inputStyle(null), width: 'auto' }}>
          <option value="admin.">إجراءات الإدارة</option><option value="admin.settings">الإعدادات فقط</option><option value="auth.">الدخول والأمان</option><option value="">الكل</option>
        </select>
      </div>
      <Table cols={['الوقت (القاهرة)', 'الإجراء', 'بواسطة', 'التفاصيل']} loading={L.loading} err={L.err} empty={!L.data?.results.length} retry={() => void L.reload()}>
        {L.data?.results.map((e) => (
          <tr key={e.id} style={{ borderTop: `1px solid ${color.divider}`, verticalAlign: 'top' }}>
            <td style={{ padding: '10px 16px', whiteSpace: 'nowrap' }}>{dateTime(e.at)}</td>
            <td style={{ padding: '10px 16px' }}>{ACTION_L[e.action] ?? e.action}</td>
            <td style={{ padding: '10px 16px' }}>{e.actor ?? '—'}</td>
            <td style={{ padding: '10px 16px', fontSize: 12, color: color.muted, fontFamily: font.latin, direction: 'ltr', textAlign: 'left', maxWidth: 360, wordBreak: 'break-word' }}>{summary(e.data)}</td>
          </tr>
        ))}
      </Table>
      <Pager page={L.page} total={L.data?.count ?? 0} setPage={L.setPage} />
    </section>
  );
}

function summary(d: Record<string, unknown>): string {
  if (d.changed && typeof d.changed === 'object') return Object.entries(d.changed as Record<string, [string, string]>).map(([k, [a, b]]) => `${k}: ${a} → ${b}`).join(' · ');
  return Object.entries(d).filter(([k]) => !['ip', 'request_id'].includes(k)).map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : String(x)}`).join(' · ').slice(0, 300);
}
