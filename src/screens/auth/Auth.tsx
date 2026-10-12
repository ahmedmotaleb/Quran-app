import type { FormEvent } from 'react';
import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { BackButton, FieldError, Spinner, inputStyle, labelStyle, linkBtn, muted, outlineBtn, primaryBtn, Chips, Segmented } from '@/components/ui';
import { DAYS, DEMO_PASSWORD } from '@/data/demo';
import { tzLabel } from '@/lib/format';
import { PW_MIN, back, doForgot, doLogin, doSignup, go, obNext, reset, setState as set, skipSplash, up, useApp } from '@/store/store';
import { LIVE } from '@/api/client';
import { BRAND } from '@/theme/brand';
import { Logo } from '@/components/Logo';

export function Splash() {
  return (
    <div onClick={skipSplash} style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 32, position: 'relative', overflow: 'hidden', cursor: 'pointer' }}>
      <div style={{ position: 'absolute', width: 520, height: 520, borderRadius: '50%', border: `56px solid ${color.sand}`, top: -300, left: -220 }} />
      <div style={{ position: 'absolute', width: 380, height: 380, borderRadius: '50%', border: `40px solid ${color.sand}`, bottom: -230, right: -170 }} />
      <Logo size={140} />
      <p style={{ margin: 0, fontSize: 20, fontWeight: 500, color: color.primary, position: 'relative', marginTop: 8 }}>{BRAND.tagline}</p>
      <div style={{ position: 'absolute', bottom: 56 }}><Spinner /></div>
    </div>
  );
}

const SLIDES = [
  { t: 'احفظ بخطة واضحة', d: 'واجبات يومية يحددها معلمك، ومراجعة منتظمة لما حفظته.' },
  { t: 'سجّل تلاوتك', d: 'أرسل تلاوتك لمعلمك، وتلقَّ ملاحظاته مرتبطة بكل موضع.' },
  { t: 'احضر حلقتك', d: 'احجز جلسة مع معلم واحضرها مباشرة من التطبيق.' },
];
export function Intro() {
  const i = useApp((s) => s.intro); const sl = SLIDES[i];
  const toLogin = () => reset('login', null);
  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', padding: '8px 20px 24px', position: 'relative', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={toLogin} style={linkBtn(15, { minHeight: 48, padding: '0 16px' })}>تخطَّ</button>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 28, textAlign: 'center' }}>
        <div style={{ width: 240, height: 240, borderRadius: '50%', background: color.sand, display: 'grid', placeItems: 'center', position: 'relative' }}>
          <div style={{ position: 'absolute', inset: 22, borderRadius: '50%', border: `2px solid ${color.sage}` }} />
          <img src="/assets/halqa-mark.png" alt="" style={{ width: 120, height: 120, objectFit: 'contain' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 300 }}>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: color.ink }}>{sl.t}</h1>
          <p style={{ margin: 0, fontSize: 16, lineHeight: 1.8, color: color.muted, textWrap: 'pretty' }}>{sl.d}</p>
        </div>
        <div style={{ display: 'flex', gap: 6 }} aria-hidden="true">
          {[0, 1, 2].map((d) => <span key={d} style={{ height: 8, borderRadius: 8, width: d === i ? 24 : 8, background: d === i ? color.primary : color.borderStrong, transition: 'width .2s' }} />)}
        </div>
      </div>
      <button onClick={() => (i < 2 ? set({ intro: i + 1 }) : toLogin())} style={primaryBtn()}>{i < 2 ? 'التالي' : 'ابدأ الآن'}</button>
    </div>
  );
}

const prevent = (fn: () => void) => (e: FormEvent) => { e.preventDefault(); fn(); };

export function Login() {
  const L = useApp((s) => s.login);
  const E = L.errors;
  return (
    <form onSubmit={prevent(doLogin)} noValidate style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', padding: '12px 20px 24px', gap: 18 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, marginTop: 4 }}>
        <Logo size={84} />
        <h1 style={{ margin: '12px 0 0', fontSize: 24, fontWeight: 800 }}>تسجيل الدخول</h1>
        <p style={muted(14, { margin: '4px 0 0' })}>تُعرض لك الواجهة المناسبة بحسب نوع حسابك</p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label htmlFor="lg-email" style={labelStyle}>البريد الإلكتروني</label>
        <input id="lg-email" type="email" dir="ltr" autoComplete="email" value={L.email} placeholder="name@example.com" aria-invalid={!!E.email}
          onChange={(e) => up('login', { email: e.target.value, errors: { ...E, email: null } })} style={inputStyle(E.email, true)} />
        <FieldError msg={E.email} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label htmlFor="lg-pw" style={labelStyle}>كلمة المرور</label>
        <div style={{ position: 'relative' }}>
          <input id="lg-pw" type={L.show ? 'text' : 'password'} dir="ltr" autoComplete="current-password" value={L.pw} aria-invalid={!!E.pw}
            onChange={(e) => up('login', { pw: e.target.value, errors: { ...E, pw: null } })} style={inputStyle(E.pw, true, { padding: '0 14px 0 52px' })} />
          <button type="button" onClick={() => up('login', { show: !L.show })} aria-label={L.show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
            style={{ position: 'absolute', left: 2, top: 2, width: 48, height: 48, border: 'none', background: 'transparent', color: color.muted, display: 'grid', placeItems: 'center', cursor: 'pointer' }}>
            <Icon name={L.show ? 'eyeOff' : 'eye'} />
          </button>
        </div>
        <FieldError msg={E.pw} />
        <button type="button" onClick={() => go('forgot')} style={linkBtn(14, { alignSelf: 'flex-start', padding: 0 })}>نسيت كلمة المرور؟</button>
      </div>
      <button type="submit" disabled={L.loading} style={primaryBtn()}>{L.loading ? 'جارٍ الدخول…' : 'تسجيل الدخول'}</button>
      {!LIVE && <div style={{ background: color.sand, borderRadius: 14, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p style={{ margin: 0, fontSize: 13, color: color.subtle }}>حسابات تجريبية (كلمة المرور {DEMO_PASSWORD}):</p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {([['yousef@halqa.app', 'طالب'], ['teacher@halqa.app', 'معلم'], ['parent@halqa.app', 'ولي أمر']] as const).map(([em, l]) => (
            <button key={em} type="button" onClick={() => up('login', { email: em, pw: DEMO_PASSWORD, errors: {} })}
              style={{ minHeight: 40, padding: '0 14px', borderRadius: 999, border: `1px solid ${color.borderStrong}`, background: color.card, color: color.primary, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>{l}</button>
          ))}
        </div>
      </div>}
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
        <p style={muted(15)}>ليس لديك حساب؟ <button type="button" onClick={() => go('signup')} style={linkBtn(15, { fontWeight: 800, padding: '0 4px' })}>أنشئ حساب طالب</button></p>
        <button type="button" onClick={() => { window.location.hash = '#/admin'; }} style={{ fontSize: 13, color: color.muted, minHeight: 44, display: 'flex', alignItems: 'center', border: 'none', background: 'transparent', textDecoration: 'underline', cursor: 'pointer' }}>دخول الإدارة</button>
      </div>
    </form>
  );
}

export function Signup() {
  const S = useApp((s) => s.signup); const E = S.errors;
  const field = (k: 'name' | 'email' | 'pw', v: string) => up('signup', { [k]: v, errors: { ...E, [k]: null } });
  return (
    <form onSubmit={prevent(doSignup)} noValidate style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', padding: '4px 20px 24px', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, margin: '0 -12px' }}>
        <BackButton onClick={back} />
        <img src="/assets/halqa-mark.png" alt={BRAND.ar} style={{ width: 34, height: 34, objectFit: 'contain' }} />
      </div>
      <div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>إنشاء حساب طالب</h1>
        <p style={muted(14, { margin: '6px 0 0', lineHeight: 1.7 })}>حسابات المعلمين وأولياء الأمور تُنشأ وتُربط من إدارة الحلقة.</p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label htmlFor="su-name" style={labelStyle}>الاسم الكامل</label>
        <input id="su-name" autoComplete="name" value={S.name} aria-invalid={!!E.name} onChange={(e) => field('name', e.target.value)} style={inputStyle(E.name)} />
        <FieldError msg={E.name} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label htmlFor="su-email" style={labelStyle}>البريد الإلكتروني</label>
        <input id="su-email" type="email" dir="ltr" autoComplete="email" value={S.email} placeholder="name@example.com" aria-invalid={!!E.email} onChange={(e) => field('email', e.target.value)} style={inputStyle(E.email, true)} />
        <FieldError msg={E.email} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label htmlFor="su-pw" style={labelStyle}>كلمة المرور</label>
        <input id="su-pw" type="password" dir="ltr" autoComplete="new-password" value={S.pw} aria-describedby="su-pw-h" aria-invalid={!!E.pw} onChange={(e) => field('pw', e.target.value)} style={inputStyle(E.pw, true)} />
        <FieldError msg={E.pw} />
        <p id="su-pw-h" style={muted(13)}>{S.pw.length >= PW_MIN ? 'كلمة مرور مناسبة' : `${PW_MIN} أحرف على الأقل`}</p>
      </div>
      <button type="submit" style={primaryBtn(54, 17, { marginTop: 8 })}>إنشاء الحساب</button>
      <p style={muted(13, { textAlign: 'center', lineHeight: 1.7 })}>بإنشاء الحساب توافق على شروط الاستخدام وسياسة الخصوصية.</p>
    </form>
  );
}

export function Forgot() {
  const F = useApp((s) => s.forgot);
  return (
    <form onSubmit={prevent(doForgot)} noValidate style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', padding: '4px 20px 24px', gap: 16 }}>
      <div style={{ margin: '0 -12px' }}><BackButton onClick={back} /></div>
      {!F.sent ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <span style={{ width: 56, height: 56, borderRadius: 16, background: color.sage, color: color.primary, display: 'grid', placeItems: 'center' }}><Icon name="lock" size={30} /></span>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>استعادة كلمة المرور</h1>
            <p style={muted(15, { margin: '6px 0 0', lineHeight: 1.7 })}>أدخل بريدك وسنرسل لك رابطًا لتعيين كلمة مرور جديدة.</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="fg-email" style={labelStyle}>البريد الإلكتروني</label>
            <input id="fg-email" type="email" dir="ltr" value={F.email} placeholder="name@example.com" aria-invalid={!!F.errors.email}
              onChange={(e) => up('forgot', { email: e.target.value, errors: {} })} style={inputStyle(F.errors.email, true)} />
            <FieldError msg={F.errors.email} />
          </div>
          <button type="submit" style={primaryBtn()}>أرسل رابط الاستعادة</button>
        </div>
      ) : (
        <div role="status" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 14, paddingTop: 40 }}>
          <span style={{ width: 72, height: 72, borderRadius: '50%', background: color.sage, color: color.primary, display: 'grid', placeItems: 'center' }}><Icon name="mail" size={30} /></span>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>تحقق من بريدك</h1>
          <p style={muted(15, { lineHeight: 1.7 })}>إن كان البريد <bdi dir="ltr" style={{ fontFamily: font.latin, color: color.ink }}>{F.email}</bdi> مسجلًا لدينا فستصلك رسالة خلال دقائق.</p>
          {!LIVE && <p style={muted(12)}>إرسال تجريبي — يحتاج ربطًا بخدمة البريد.</p>}
          <button type="button" onClick={() => { up('forgot', { sent: false }); back(); }} style={primaryBtn(52, 16, { padding: '0 24px' })}>العودة لتسجيل الدخول</button>
        </div>
      )}
    </form>
  );
}

const LEVELS = [['مبتدئ', 'أبدأ من جزء عمّ'], ['متوسط', 'أحفظ عدة أجزاء وأريد الاستمرار'], ['متقدم', 'أراجع حفظي وأتقن التجويد']] as const;
const GOALS = [['3 أسطر يوميًا', 'حوالي 10 دقائق'], ['5 أسطر يوميًا', 'حوالي 20 دقيقة'], ['نصف صفحة يوميًا', 'حوالي 30 دقيقة'], ['صفحة يوميًا', 'حوالي 45 دقيقة']] as const;

export function Onboard() {
  const O = useApp((s) => s.ob); const tz = useApp((s) => s.tz);
  const radio = (sel: boolean) => ({ border: `1.5px solid ${sel ? color.primary : color.borderChip}`, background: sel ? color.sageTint : color.card });
  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', padding: '12px 20px 24px', gap: 18 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p style={muted(13, { fontWeight: 700 })}>الخطوة {O.step + 1} من 3</p>
        <div role="progressbar" aria-valuenow={O.step + 1} aria-valuemin={1} aria-valuemax={3} style={{ height: 6, borderRadius: 6, background: color.track, overflow: 'hidden' }}>
          <div style={{ height: '100%', background: color.primary, borderRadius: 6, width: `${((O.step + 1) / 3) * 100}%`, transition: 'width .2s' }} />
        </div>
      </div>
      {O.step === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>ما مستواك الحالي؟</h1>
          <p style={muted(15)}>يساعد معلمك على إعداد خطة مناسبة لك.</p>
          <div role="radiogroup" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {LEVELS.map(([k, d]) => {
              const sel = O.level === k;
              return (
                <button key={k} role="radio" aria-checked={sel} onClick={() => up('ob', { level: k, error: null })}
                  style={{ minHeight: 72, padding: '12px 16px', borderRadius: 16, ...radio(sel), display: 'flex', alignItems: 'center', gap: 12, textAlign: 'right', cursor: 'pointer' }}>
                  <span style={{ flex: 1 }}>
                    <span style={{ display: 'block', fontSize: 17, fontWeight: 700, color: color.ink }}>{k}</span>
                    <span style={{ display: 'block', fontSize: 14, color: color.muted, marginTop: 2 }}>{d}</span>
                  </span>
                  {sel && <span style={{ width: 28, height: 28, borderRadius: '50%', background: color.primary, color: color.ivory, display: 'grid', placeItems: 'center' }}><Icon name="check" size={18} /></span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {O.step === 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>ما هدفك اليومي؟</h1>
          <p style={muted(15)}>يمكنك تغييره لاحقًا من حسابك.</p>
          <div role="radiogroup" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {GOALS.map(([k, d]) => {
              const sel = O.goal === k;
              return (
                <button key={k} role="radio" aria-checked={sel} onClick={() => up('ob', { goal: k, error: null })}
                  style={{ minHeight: 88, padding: 12, borderRadius: 16, ...radio(sel), display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4, textAlign: 'right', cursor: 'pointer' }}>
                  <span style={{ fontSize: 16, fontWeight: 700, color: color.ink }}>{k}</span>
                  <span style={{ fontSize: 13, color: color.muted }}>{d}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {O.step === 2 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>متى تفضّل جلساتك؟</h1>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>الأيام</p>
          <Chips h={44} options={DAYS.map(([d]) => [d, d] as const)} value={O.days}
            onChange={(k) => up('ob', { days: O.days.includes(k) ? O.days.filter((x) => x !== k) : [...O.days, k], error: null })} />
          <p style={{ margin: '6px 0 0', fontSize: 15, fontWeight: 700 }}>الفترة</p>
          <Segmented options={[['صباحًا', 'صباحًا'], ['عصرًا', 'عصرًا'], ['مساءً', 'مساءً']] as const} value={O.period as 'صباحًا'} onChange={(k) => up('ob', { period: k })} />
          <p style={muted(14, { display: 'flex', gap: 6, alignItems: 'center' })}><Icon name="globe" size={18} /> المواعيد {tzLabel(tz)}</p>
        </div>
      )}
      <FieldError msg={O.error} fs={14} />
      <div style={{ marginTop: 'auto', display: 'flex', gap: 10 }}>
        {O.step > 0 && <button onClick={() => up('ob', { step: O.step - 1, error: null })} style={outlineBtn(54, 16, { padding: '0 20px' })}>السابق</button>}
        <button onClick={obNext} style={primaryBtn(54, 17, { flex: 1 })}>{O.step === 2 ? 'ابدأ رحلتك' : 'التالي'}</button>
      </div>
    </div>
  );
}
