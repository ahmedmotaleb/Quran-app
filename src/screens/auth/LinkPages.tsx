import { useState, type FormEvent, type ReactNode } from 'react';
import { color } from '@/theme/tokens';
import { FieldError, inputStyle, labelStyle, primaryBtn } from '@/components/ui';
import { Logo } from '@/components/Logo';
import { api, ApiError, LIVE } from '@/api/client';

/** Pages opened from a link the person received: set a password (`#/reset`) or accept an invitation (`#/invite`). */
const params = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '');
const toSignIn = () => { window.location.hash = '#/'; window.location.reload(); };

function Frame({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div dir="rtl" lang="ar" style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 16, background: color.ivory }}>
      <div style={{ width: '100%', maxWidth: 420, background: color.card, border: `1px solid ${color.border}`, borderRadius: 20, padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, textAlign: 'center' }}>
          <Logo size={64} />
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>{title}</h1>
          <p style={{ margin: 0, fontSize: 14, color: color.muted }}>{sub}</p>
        </div>
        {LIVE ? children : <p style={{ margin: 0, color: color.muted }}>هذه الصفحة تعمل مع الخادم فقط.</p>}
      </div>
    </div>
  );
}

function Field({ id, label, type = 'text', value, onChange, err, auto, ltr }: {
  id: string; label: string; type?: string; value: string; onChange: (v: string) => void; err?: string | null; auto?: string; ltr?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      <input id={id} type={type} dir={ltr ? 'ltr' : undefined} autoComplete={auto} value={value} aria-invalid={!!err}
        onChange={(e) => onChange(e.target.value)} style={inputStyle(err, ltr)} />
      <FieldError msg={err} />
    </div>
  );
}

const Done = ({ text }: { text: string }) => (
  <>
    <p role="status" style={{ margin: 0, fontSize: 15, textAlign: 'center' }}>{text}</p>
    <button onClick={toSignIn} style={primaryBtn(52, 16)}>الذهاب إلى تسجيل الدخول</button>
  </>
);

/** `#/reset?uid=…&token=…` — first password (account created by the admin) or recovery. */
export function SetPasswordPage() {
  const q = params();
  const [pw, setPw] = useState(''); const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<Record<string, string | null>>({}); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.length < 10) return setErr({ pw: 'كلمة المرور 10 أحرف على الأقل.' });
    if (pw !== pw2) return setErr({ pw2: 'كلمتا المرور غير متطابقتين.' });
    setBusy(true); setErr({});
    try {
      await api('POST', 'auth/password/reset', { uid: q.get('uid'), token: q.get('token'), password: pw });
      setDone(true);
    } catch (x) {
      const a = x as ApiError;
      setErr(a.field?.('password') ? { pw: a.field('password') } : { form: a.message });
    } finally { setBusy(false); }
  };
  return (
    <Frame title="تعيين كلمة المرور" sub="اختر كلمة مرور لحسابك في الحلقة">
      {done ? <Done text="تم تعيين كلمة المرور. سجّل الدخول ببريدك وكلمة المرور الجديدة." /> : (
        <form noValidate onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field id="sp-pw" label="كلمة المرور الجديدة" type="password" auto="new-password" ltr value={pw} onChange={setPw} err={err.pw} />
          <Field id="sp-pw2" label="أعد كتابة كلمة المرور" type="password" auto="new-password" ltr value={pw2} onChange={setPw2} err={err.pw2} />
          {err.form && <FieldError msg={err.form} />}
          <button type="submit" disabled={busy} style={primaryBtn(52, 16)}>{busy ? 'جارٍ الحفظ…' : 'حفظ كلمة المرور'}</button>
        </form>
      )}
    </Frame>
  );
}

/** `#/invite?code=…` — a teacher creates their account from the admin's invitation. */
export function AcceptInvitePage() {
  const code = params().get('code') ?? '';
  const [f, setF] = useState({ name: '', email: '', pw: '' });
  const [err, setErr] = useState<Record<string, string | null>>({}); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const x: Record<string, string> = {};
    if (f.name.trim().length < 2) x.name = 'اكتب اسمك الكامل.';
    if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) x.email = 'اكتب البريد الإلكتروني الذي وصلته الدعوة.';
    if (f.pw.length < 10) x.pw = 'كلمة المرور 10 أحرف على الأقل.';
    if (Object.keys(x).length) return setErr(x);
    setBusy(true); setErr({});
    try {
      await api('POST', 'auth/invitations/accept', { code, full_name: f.name.trim(), email: f.email.trim().toLowerCase(), password: f.pw });
      setDone(true);
    } catch (y) {
      const a = y as ApiError;
      const fe = { name: a.field?.('full_name') ?? null, email: a.field?.('email') ?? null, pw: a.field?.('password') ?? null };
      setErr(fe.name || fe.email || fe.pw ? fe : { form: a.message });
    } finally { setBusy(false); }
  };
  return (
    <Frame title="الانضمام معلمًا" sub="أنشئ حسابك من دعوة إدارة الحلقة">
      {done ? <Done text="تم إنشاء حساب المعلم. سجّل الدخول من التطبيق." /> : (
        <form noValidate onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field id="iv-name" label="الاسم الكامل" auto="name" value={f.name} onChange={(v) => setF({ ...f, name: v })} err={err.name} />
          <Field id="iv-email" label="البريد الإلكتروني" type="email" auto="email" ltr value={f.email} onChange={(v) => setF({ ...f, email: v })} err={err.email} />
          <Field id="iv-pw" label="كلمة المرور" type="password" auto="new-password" ltr value={f.pw} onChange={(v) => setF({ ...f, pw: v })} err={err.pw} />
          {err.form && <FieldError msg={err.form} />}
          <button type="submit" disabled={busy || !code} style={primaryBtn(52, 16)}>{busy ? 'جارٍ الإنشاء…' : 'إنشاء الحساب'}</button>
        </form>
      )}
    </Frame>
  );
}
