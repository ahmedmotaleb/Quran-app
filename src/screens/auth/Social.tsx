/** «المتابعة باستخدام Google / Apple / Microsoft» (owner request, 27 Nov 2026). The server does the OpenID Connect work
 *  (apps/accounts/social.py); the app only:
 *  - asks the server which providers are configured and shows their buttons (none → nothing shown);
 *  - starts a provider (POST …/start → the provider's page in this same window: the system browser, never a WebView);
 *  - handles `#/oauth?…` when the browser comes back: redeems the one-time ticket for this device's normal session,
 *    completes a new account (the role choice is checked by the server), confirms an emailed link, or explains the
 *    outcome; then reloads the app, which restores the session as usual (notification settings and this device's
 *    push registration included, never asking for permission again).
 *  - «طرق تسجيل الدخول» in «حسابي»: connected providers, connect / disconnect, a password, and signed-in devices. */
import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { color } from '@/theme/tokens';
import { FieldError, card, inputStyle, labelStyle, muted, primaryBtn } from '@/components/ui';
import { api, ApiError } from '@/api/client';
import { openSheet, setState, toast } from '@/store/store';

type Provider = 'google' | 'apple' | 'microsoft' | 'fake';
const NAME: Record<Provider, string> = { google: 'Google', apple: 'Apple', microsoft: 'Microsoft', fake: 'التجريبي' };
const errText = (e: unknown) => (e as ApiError)?.message || 'تعذّر تنفيذ الطلب.';
const deviceZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Cairo'; } catch { return 'Africa/Cairo'; } };

/* ---------------- the providers' marks (their own colours, as their guidelines ask) ---------------- */
function Mark({ p }: { p: Provider }) {
  if (p === 'google') return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 38.2 44 33 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>);
  if (p === 'apple') return (
    <svg width="18" height="20" viewBox="0 0 17 20" aria-hidden="true"><path fill="currentColor" d="M14.1 10.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9C3.5 4.8 1.9 5.8 1 7.4c-1.8 3.2-.5 7.9 1.3 10.5.9 1.3 1.9 2.7 3.2 2.6 1.3-.1 1.8-.8 3.3-.8s2 .8 3.4.8 2.2-1.3 3.1-2.6c1-1.5 1.4-2.9 1.4-3-.1 0-2.6-1-2.6-4.3zM11.6 3c.7-.9 1.2-2 1.1-3.2-1 .1-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.1.1 2.3-.6 3-1.5z"/></svg>);
  if (p === 'microsoft') return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#F25022"/><rect x="11" y="1" width="9" height="9" fill="#7FBA00"/><rect x="1" y="11" width="9" height="9" fill="#00A4EF"/><rect x="11" y="11" width="9" height="9" fill="#FFB900"/></svg>);
  return <span aria-hidden="true">🧪</span>;
}
const btnStyle = (p: Provider): CSSProperties => ({
  minHeight: 52, width: '100%', borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, fontSize: 16, fontWeight: 700,
  cursor: 'pointer', border: p === 'apple' ? '1px solid #000' : `1px solid ${color.borderStrong}`, background: p === 'apple' ? '#000' : '#fff', color: p === 'apple' ? '#fff' : '#1F1F1F',
});

let providersCache: Promise<Provider[]> | null = null;
export function useProviders() {
  const [list, setList] = useState<Provider[]>([]);
  useEffect(() => {
    providersCache ??= api<{ providers: { id: Provider }[] }>('GET', 'auth/oauth/providers').then((r) => r.providers.map((x) => x.id)).catch(() => { providersCache = null; return []; });
    void providersCache.then(setList);
  }, []);
  return list;
}

/** Leave for the provider's page. `link` = connect to the signed-in account. */
export async function startProvider(p: Provider, intent: 'login' | 'link') {
  const r = await api<{ auth_url: string }>('POST', `auth/oauth/${p}/start`, { intent, client: 'web' });
  window.location.assign(r.auth_url);
}

/** The sign-in screen's buttons (below the email and password, which stay). */
export function SocialButtons() {
  const list = useProviders(); const [busy, setBusy] = useState<Provider | null>(null);
  if (!list.length) return null;
  const go = async (p: Provider) => { setBusy(p); try { await startProvider(p, 'login'); } catch (e) { toast(errText(e), 'alert'); setBusy(null); } };
  return (
    <div data-testid="social-buttons" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: color.muted, fontSize: 14 }}>
        <span style={{ flex: 1, height: 1, background: color.divider }} /> أو <span style={{ flex: 1, height: 1, background: color.divider }} />
      </div>
      {list.map((p) => (
        <button key={p} type="button" disabled={!!busy} aria-busy={busy === p} onClick={() => void go(p)} style={btnStyle(p)}>
          <Mark p={p} /> {busy === p ? 'جارٍ التحويل…' : `المتابعة باستخدام ${NAME[p]}`}
        </button>
      ))}
    </div>
  );
}

/* ---------------- back from the provider: `#/oauth?…` ---------------- */
const RESULT: Record<string, string> = {
  cancelled: 'أُلغي تسجيل الدخول. يمكنك المحاولة مرة أخرى.',
  failed: 'تعذّر إكمال تسجيل الدخول. ابدأ من جديد.',
  email_unverified: 'هذا الحساب لا يؤكد بريده الإلكتروني لدينا. أنشئ حسابك بالبريد وكلمة المرور ثم اربطه من «طرق تسجيل الدخول».',
  signup_closed: 'التسجيل العام مغلق حاليًا. تواصل مع إدارة الحلقة لإنشاء حسابك.',
  identity_in_use: 'هذا الحساب مرتبط بحساب آخر في الحلقة.',
  provider_already_linked: 'لديك حساب مرتبط من هذا المزوّد بالفعل. افصله أولًا لربط حساب آخر.',
};
const REASON: Record<string, string> = { state_expired: 'انتهت مهلة الطلب (10 دقائق).', state_invalid: 'بدأ الطلب من متصفح أو جهاز آخر.' };

export function OAuthReturn() {
  const q = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const [state, setLocal] = useState<'working' | 'signup' | 'message'>(q.get('ticket') || q.get('confirm') ? 'working' : q.get('signup') ? 'signup' : 'message');
  const [msg, setMsg] = useState('');
  const provider = (q.get('provider') ?? '') as Provider;
  const done = (after: { note?: string; open?: string; onboard?: boolean } = {}) => {
    try {
      if (after.note) sessionStorage.setItem('halqa.oauth.note', after.note);
      if (after.open) sessionStorage.setItem('halqa.oauth.open', after.open);
      if (after.onboard) sessionStorage.setItem('halqa.oauth.onboard', '1');
    } catch { /* private mode */ }
    window.location.replace('/');   // the app starts again and restores this session (and this device's notifications)
  };
  useEffect(() => {
    const ticket = q.get('ticket'); const confirm = q.get('confirm');
    if (ticket) api('POST', 'auth/oauth/finish', { ticket, client: 'web' }).then(() => done()).catch((e) => { setMsg(errText(e)); setLocal('message'); });
    else if (confirm) api('POST', 'auth/oauth/confirm', { token: confirm, client: 'web' }).then(() => done({ note: 'تم ربط الحساب وتسجيل الدخول.' }))
      .catch((e) => { setMsg(errText(e)); setLocal('message'); });
    else if (q.get('result') === 'linked') done({ note: `تم ربط ${NAME[provider] ?? ''} بحسابك.`, open: 'account' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const r = q.get('result') ?? '';
  const text = msg || (r === 'link_email_sent' ? `يوجد حساب في الحلقة بالبريد ${q.get('email') ?? ''}. أرسلنا إليه رابط تأكيد؛ افتحه لربط ${NAME[provider] ?? ''} وتسجيل الدخول. لا نربط الحسابات تلقائيًا حمايةً لحسابك.`
    : r === 'link_required' ? `يوجد حساب في الحلقة بالبريد ${q.get('email') ?? ''}. سجّل الدخول بكلمة المرور، ثم اربط ${NAME[provider] ?? ''} من «حسابي ← طرق تسجيل الدخول».`
    : RESULT[r] ? `${RESULT[r]}${q.get('reason') ? ` ${REASON[q.get('reason')!] ?? ''}` : ''}` : RESULT.failed);
  const page: CSSProperties = { minHeight: '100dvh', background: color.ivory, padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 520, margin: '0 auto' };
  if (state === 'working') return <main dir="rtl" style={page}><p role="status" style={{ margin: 'auto', fontSize: 16 }}>جارٍ تسجيل الدخول…</p></main>;
  if (state === 'signup') return <main dir="rtl" style={page}><CompleteSignup ticket={q.get('signup')!} name={q.get('name') ?? ''} email={q.get('email') ?? ''} provider={provider} onDone={(role) => done({ onboard: role === 'student' })} /></main>;
  return (
    <main dir="rtl" style={page}>
      <img src="/assets/halqa-mark.png" alt="الحلقة" style={{ width: 64, height: 64, objectFit: 'contain', alignSelf: 'center' }} />
      <p role="alert" data-testid="oauth-message" style={{ margin: 0, fontSize: 16, lineHeight: 1.8, textAlign: 'center' }}>{text}</p>
      <button onClick={() => window.location.replace('/')} style={primaryBtn(52, 16)}>العودة إلى الحلقة</button>
    </main>
  );
}

function CompleteSignup({ ticket, name, email, provider, onDone }: { ticket: string; name: string; email: string; provider: Provider; onDone: (role: string) => void }) {
  const [v, setV] = useState({ role: '', full_name: name, gender: '' });
  const [errs, setErrs] = useState<Record<string, string | undefined>>({}); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const local = { role: v.role ? undefined : 'اختر نوع الحساب.', full_name: v.full_name.trim().length >= 2 ? undefined : 'أدخل اسمك الكامل.', gender: v.gender ? undefined : 'اختر: ذكر أو أنثى.' };
    if (Object.values(local).some(Boolean)) return setErrs(local);
    setBusy(true); setErrs({});
    try { await api('POST', 'auth/oauth/signup', { ticket, ...v, timezone: deviceZone(), client: 'web' }); onDone(v.role); }
    catch (x) { const a = x as ApiError; setErrs({ form: a.message, role: a.field?.('role') ?? undefined, full_name: a.field?.('full_name') ?? undefined, gender: a.field?.('gender') ?? undefined }); setBusy(false); }
  };
  const pill = (on: boolean): CSSProperties => ({ flex: 1, minHeight: 52, borderRadius: 14, border: `1.5px solid ${on ? color.primary : color.borderInput}`, background: on ? color.primary : color.card, color: on ? color.ivory : color.ink, fontSize: 16, fontWeight: 700, cursor: 'pointer' });
  const ROLES: [string, string, string][] = [['student', 'طالب', 'حفظ ومراجعة وجلسات مع معلمك.'], ['teacher', 'معلم', 'يُراجع حسابك ويعتمده فريق الحلقة قبل ظهوره للطلاب.'], ['parent', 'ولي أمر', 'تربط إدارة الحلقة حسابك بأبنائك لتتابعهم.']];
  return (
    <form onSubmit={submit} noValidate aria-label="إكمال إنشاء الحساب" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <img src="/assets/halqa-mark.png" alt="الحلقة" style={{ width: 56, height: 56, objectFit: 'contain', alignSelf: 'center' }} />
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>أكمل إنشاء حسابك</h1>
      <p style={muted(14, { margin: 0, lineHeight: 1.7 })}>تحققنا من حسابك في {NAME[provider] ?? ''} <bdi dir="ltr">{email}</bdi>. اختر نوع حسابك وأكمل بياناتك.</p>
      <div role="radiogroup" aria-label="نوع الحساب" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {ROLES.map(([k, l, d]) => (
          <button key={k} type="button" role="radio" aria-checked={v.role === k} onClick={() => setV({ ...v, role: k })}
            style={{ ...card, padding: '12px 14px', textAlign: 'right', border: `1.5px solid ${v.role === k ? color.primary : color.border}`, background: v.role === k ? color.sageTint : color.card, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: color.ink }}>{l}</span><span style={muted(13)}>{d}</span>
          </button>
        ))}
      </div>
      <FieldError msg={errs.role} />
      <label style={{ ...labelStyle, display: 'flex', flexDirection: 'column', gap: 6 }}>الاسم الكامل
        <input autoComplete="name" value={v.full_name} onChange={(e) => setV({ ...v, full_name: e.target.value })} style={inputStyle(errs.full_name)} aria-invalid={!!errs.full_name} />
      </label>
      <FieldError msg={errs.full_name} />
      <div role="radiogroup" aria-label="الجنس" style={{ display: 'flex', gap: 8 }}>
        {([['male', 'ذكر'], ['female', 'أنثى']] as const).map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={v.gender === k} onClick={() => setV({ ...v, gender: k })} style={pill(v.gender === k)}>{l}</button>)}
      </div>
      <FieldError msg={errs.gender} />
      {errs.form && <p role="alert" style={{ margin: 0, color: color.dangerInk, fontWeight: 700 }}>{errs.form}</p>}
      <button type="submit" disabled={busy} aria-busy={busy} style={primaryBtn(54, 17)}>{busy ? 'جارٍ إنشاء الحساب…' : 'إنشاء الحساب'}</button>
      <button type="button" onClick={() => window.location.replace('/')} style={{ minHeight: 44, border: 'none', background: 'transparent', color: color.muted, cursor: 'pointer' }}>إلغاء</button>
    </form>
  );
}

/* ---------------- «طرق تسجيل الدخول» in «حسابي» ---------------- */
interface Methods { has_password: boolean; providers: { id: Provider; label: string; available: boolean; connected: boolean; email: string }[] }
interface SessionRow { id: number; device: string; method: string; method_label: string; app: string; created_at: string; current: boolean }

export function SignInMethods() {
  const [m, setM] = useState<Methods | null>(null); const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [busy, setBusy] = useState(false); const [pw, setPw] = useState<string | null>(null); const [pwErr, setPwErr] = useState<string | undefined>();
  const load = () => {
    api<Methods>('GET', 'me/auth-methods').then(setM).catch(() => setM(null));
    api<{ results: SessionRow[] }>('GET', 'me/sessions').then((r) => setRows(r.results)).catch(() => setRows([]));
  };
  useEffect(load, []);
  const run = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); try { await fn(); toast(ok); load(); } catch (e) { toast(errText(e), 'alert'); } finally { setBusy(false); } };
  const confirm = (title: string, body: string, ok: string, fn: () => void) => openSheet({ kind: 'confirm', title, body, ok, danger: true, onOk: () => { setState({ sheet: null }); fn(); } });
  if (!m) return null;
  const ways = (m.has_password ? 1 : 0) + m.providers.filter((p) => p.connected).length;
  const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, minHeight: 52, borderTop: `1px solid ${color.divider}` };
  const small = (danger = false): CSSProperties => ({ minHeight: 40, padding: '0 12px', borderRadius: 10, border: `1px solid ${danger ? color.dangerInk : color.borderStrong}`, background: color.card, color: danger ? color.dangerInk : color.primary, fontSize: 13, fontWeight: 700, cursor: 'pointer' });
  const dt = (iso: string) => new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  return (
    <section aria-labelledby="sim-h" data-testid="sign-in-methods" style={{ ...card, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <h2 id="sim-h" style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 800 }}>طرق تسجيل الدخول</h2>
      {m.providers.map((p) => (
        <div key={p.id} style={row}>
          <span style={{ width: 28, display: 'grid', placeItems: 'center', color: '#000' }}><Mark p={p.id} /></span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontWeight: 700 }}>{NAME[p.id]}</span>
            <span style={muted(12)}>{p.connected ? <>مرتبط{p.email ? <> · <bdi dir="ltr">{p.email}</bdi></> : null}</> : p.available ? 'غير مرتبط' : 'غير متاح حاليًا'}</span>
          </span>
          {p.connected
            ? <button disabled={busy || ways <= 1} title={ways <= 1 ? 'آخر طريقة للدخول' : undefined} onClick={() => confirm(`فصل ${NAME[p.id]}؟`, `لن تتمكن من الدخول باستخدام ${NAME[p.id]} بعد الآن.`, 'فصل', () => void run(() => api('DELETE', `me/auth-methods/${p.id}`), `فُصل ${NAME[p.id]}`))} style={small(true)}>فصل</button>
            : p.available && <button disabled={busy} onClick={() => void startProvider(p.id, 'link').catch((e) => toast(errText(e), 'alert'))} style={small()}>ربط</button>}
        </div>
      ))}
      <div style={row}>
        <span style={{ width: 28, display: 'grid', placeItems: 'center' }} aria-hidden="true">🔑</span>
        <span style={{ flex: 1 }}><span style={{ display: 'block', fontWeight: 700 }}>كلمة المرور</span><span style={muted(12)}>{m.has_password ? 'معيّنة' : 'غير معيّنة'}</span></span>
        {!m.has_password && pw === null && <button onClick={() => { setPw(''); setPwErr(undefined); }} style={small()}>تعيين كلمة مرور</button>}
      </div>
      {!m.has_password && pw !== null && (
        <form onSubmit={(e) => { e.preventDefault(); setBusy(true); api('POST', 'auth/password/set', { password: pw }).then(() => { toast('عُيّنت كلمة المرور'); setPw(null); load(); })
          .catch((x) => setPwErr((x as ApiError).field?.('password') ?? errText(x))).finally(() => setBusy(false)); }} style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingBottom: 8 }}>
          <input type="password" dir="ltr" autoComplete="new-password" aria-label="كلمة المرور الجديدة" value={pw} onChange={(e) => setPw(e.target.value)} style={inputStyle(pwErr, true)} />
          <FieldError msg={pwErr} />
          <div style={{ display: 'flex', gap: 8 }}><button type="submit" disabled={busy || pw.length < 10} style={small()}>حفظ</button><button type="button" onClick={() => setPw(null)} style={small()}>إلغاء</button></div>
        </form>
      )}
      {m.has_password && <p style={muted(12, { margin: '0 0 4px' })}>لتغيير كلمة المرور استخدم «تغيير كلمة المرور».</p>}
      <h3 style={{ margin: '12px 0 4px', fontSize: 15, fontWeight: 800 }}>الأجهزة المسجّلة</h3>
      {(rows ?? []).map((s) => (
        <div key={s.id} style={row}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontWeight: 700 }}>{s.device}{s.current ? ' · هذا الجهاز' : ''}</span>
            <span style={muted(12)}>{s.app} · {s.method === 'password' ? 'كلمة المرور' : NAME[s.method as Provider] ?? s.method_label} · منذ {dt(s.created_at)}</span>
          </span>
          {!s.current && <button disabled={busy} onClick={() => void run(() => api('DELETE', `me/sessions/${s.id}`), 'سُجّل الخروج من الجهاز')} style={small(true)}>خروج</button>}
        </div>
      ))}
      {(rows ?? []).filter((s) => !s.current).length > 0 && (
        <button disabled={busy} onClick={() => confirm('تسجيل الخروج من الأجهزة الأخرى؟', 'يُسجَّل الخروج من كل جهاز غير هذا، وتتوقف إشعاراته.', 'تسجيل الخروج', () => void run(() => api('POST', 'me/sessions/end-others'), 'سُجّل الخروج من الأجهزة الأخرى'))}
          style={{ ...small(true), alignSelf: 'flex-start', marginTop: 8 }}>تسجيل الخروج من الأجهزة الأخرى</button>
      )}
    </section>
  );
}
