import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { BackButton, FieldError, Segmented, Switch, card, dangerOutlineBtn, inputStyle, labelStyle, outlineBtn, primaryBtn } from '@/components/ui';
import { tzOf } from '@/lib/format';
import { go, logout, openSheet, setState, toast, up, useApp } from '@/store/store';
import { INSTALL_STEPS, promptInstall, useInstall } from '@/pwa/install';
import { LIVE, type ApiError } from '@/api/client';
import { saveGender } from '@/store/live';
import * as E from '@/api/endpoints';
import { useEffect, useState, type FormEvent } from 'react';
import { disablePush, enablePush, PushError, pushState, type PushState } from '@/pwa/push';
import { GoogleCalendarCard } from '@/screens/teacher/GoogleSessions';

/** The admin portal may run on its own address (the admin service); ask the server where. */
async function openAdmin() {
  let base = '';
  try { base = (await E.publicSettings()).admin_url ?? ''; } catch { /* same origin */ }
  window.location.href = `${base}/admin/`;
}

const NOTIFS = [['tasks', 'تذكير بالواجبات'], ['sessions', 'تذكير قبل الجلسات'], ['feedback', 'تقييمات المعلم'], ['news', 'أخبار الحلقة']] as const;
const rowBtn = { width: '100%', minHeight: 52, border: 'none', background: 'transparent', display: 'flex', alignItems: 'center', gap: 8, padding: 0, cursor: 'pointer', color: color.ink, fontSize: 15 } as const;

export default function Account() {
  const s = useApp(); const role = s.role;
  const live = s.liveMode;
  const name = live ? s.user.name : role === 'teacher' ? 'الشيخ عبدالرحمن السالم' : role === 'parent' ? 'أحمد العلي' : s.user.name;
  const email = live ? s.user.email : role === 'teacher' ? 'teacher@halqa.app' : role === 'parent' ? 'parent@halqa.app' : s.user.email;
  // Live: the teachers who assigned this student's tasks.
  const myTeachers = [...new Set(s.tasks.map((t) => t.teacherName).filter(Boolean))].join('، ') || 'لم يُربط معلم بعد';
  const ini = live ? (s.user.first[0] ?? '؟') : role === 'teacher' ? 'ع' : role === 'parent' ? 'أ' : s.user.first[0];
  const roleL = { student: 'حساب طالب', teacher: 'حساب معلم', parent: 'حساب ولي أمر', admin: 'حساب إدارة' }[role || 'student'];
  const tz = tzOf(s.tz);

  return (
    <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
        {role === 'parent' && <BackButton style={{ marginInlineStart: -8 }} />}
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>حسابي</h1>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, ...card, padding: 16 }}>
        <span aria-hidden="true" style={{ width: 60, height: 60, borderRadius: '50%', background: color.primary, color: color.ivory, fontSize: 24, fontWeight: 800, display: 'grid', placeItems: 'center' }}>{ini}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{name}</p>
          <p dir="ltr" style={{ margin: '2px 0 0', fontFamily: font.latin, fontSize: 13, color: color.muted, textAlign: 'right' }}>{email}</p>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: color.primary, fontWeight: 700 }}>{roleL}</p>
        </div>
      </div>
      {role === 'student' && (
        <section style={{ ...card, padding: '4px 16px' }}>
          <h2 style={{ margin: '12px 0 4px', fontSize: 14, color: color.muted, fontWeight: 700 }}>التعلّم</h2>
          {([['المستوى', s.user.level], ['الهدف اليومي', s.user.goal], ['المعلم المرتبط', live ? myTeachers : 'الشيخ عبدالرحمن السالم']] as const).map(([k, v], i) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderBottom: i < 2 ? `1px solid ${color.divider}` : 'none' }}>
              <span style={{ fontSize: 15 }}>{k}</span><span style={{ fontSize: 15, fontWeight: 700 }}>{v}</span>
            </div>
          ))}
        </section>
      )}
      {role === 'teacher' && (
        <button onClick={() => go('tcontent')} style={{ minHeight: 60, padding: '0 16px', borderRadius: 16, border: `1px solid ${color.border}`, background: color.card, display: 'flex', alignItems: 'center', gap: 12, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
          <span style={{ color: color.primary }}><Icon name="layers" /></span><span style={{ flex: 1, fontSize: 15, fontWeight: 700 }}>إنشاء محاضرة أو اختبار</span><span style={{ color: color.primary }}><Icon name="chevL" /></span>
        </button>
      )}
      <section style={{ ...card, padding: '4px 16px' }}>
        <h2 style={{ margin: '12px 0 4px', fontSize: 14, color: color.muted, fontWeight: 700 }}>الإشعارات</h2>
          {LIVE && <p style={{ margin: '0 0 4px', fontSize: 12, color: color.muted }}>تتحكم في إشعارات الجوال لكل نوع. تنبيهات الحساب والحضور تصل دائمًا، وتبقى كل الإشعارات داخل التطبيق.</p>}
        {NOTIFS.map(([k, l]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 52, borderBottom: `1px solid ${color.divider}` }}>
            <span style={{ fontSize: 15 }}>{l}</span>
            <Switch on={s.notif[k]} label={l} onToggle={() => setNotif(k, !s.notif[k])} />
          </div>
        ))}
      </section>
      <section style={{ ...card, padding: '4px 16px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2 style={{ margin: '12px 0 0', fontSize: 14, color: color.muted, fontWeight: 700 }}>العرض</h2>
        <p style={{ margin: 0, fontSize: 15, display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="type" size={18} /> حجم الخط</p>
        <Segmented role="group" label="حجم الخط" options={[['s', 'صغير'], ['m', 'متوسط'], ['l', 'كبير']] as const} value={s.uiScale} onChange={(k) => setState({ uiScale: k })} />
        <button onClick={() => openSheet({ kind: 'tz' })} style={{ ...rowBtn, textAlign: 'right' }}>
          <span style={{ color: color.primary }}><Icon name="globe" size={18} /></span><span style={{ flex: 1 }}>المنطقة الزمنية</span>
          <span style={{ fontSize: 14, fontWeight: 700 }}>{tz.label} ({tz.gmt})</span><span style={{ color: color.primary }}><Icon name="chevL" size={18} /></span>
        </button>
      </section>
      {LIVE && role === 'teacher' && s.me?.admin_access?.active && (
        // «معلم + إدارة»: the same account opens the admin portal (its own sign-in with two-step verification).
        <button onClick={openAdmin} style={{ minHeight: 60, padding: '0 16px', borderRadius: 16, border: `1px solid ${color.border}`, background: color.card, display: 'flex', alignItems: 'center', gap: 12, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
          <span style={{ color: color.primary }}><Icon name="shield" /></span>
          <span style={{ flex: 1 }}><span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>لوحة الإدارة</span>
            <span style={{ display: 'block', fontSize: 12, color: color.muted }}>لديك صلاحيات إدارة على هذا الحساب</span></span>
          <span style={{ color: color.primary }}><Icon name="chevL" /></span>
        </button>
      )}
      {LIVE && role === 'student' && (
        <section style={{ ...card, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 14, color: color.muted, fontWeight: 700 }}>الجنس</h2>
          {!s.me?.gender && <p style={{ margin: 0, fontSize: 13, color: color.warnInk }}>اختر الجنس لإكمال بيانات حسابك.</p>}
          <Segmented role="group" label="الجنس" options={[['male', 'ذكر'], ['female', 'أنثى']] as const}
            value={(s.me?.gender || '') as 'male' | 'female'} onChange={(g) => void saveGender(g, 'حُفظ')} />
        </section>
      )}
      {LIVE && role === 'teacher' && (
        <section style={{ ...card, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 14, color: color.muted, fontWeight: 700 }}>اللقب الظاهر للطلاب وأولياء الأمور</h2>
          {!s.me?.gender && <p style={{ margin: 0, fontSize: 13, color: color.warnInk }}>اختر لقبك؛ يظهر اسمك حاليًا دون لقب.</p>}
          <Segmented role="group" label="اللقب" options={[['male', 'الشيخ'], ['female', 'الأستاذة']] as const}
            value={(s.me?.gender || '') as 'male' | 'female'} onChange={(g) => void saveGender(g)} />
          <p style={{ margin: 0, fontSize: 12, color: color.muted }}>يُعرض اسمك «{s.user.name}». لا يُضاف اللقب إلى اسمك المحفوظ.</p>
        </section>
      )}
      {LIVE && role === 'teacher' && <GoogleCalendarCard />}
      {LIVE && <PhoneRow />}
      <InstallRow />
      {LIVE && <PushRow />}
      <section style={{ ...card, padding: '4px 16px' }}>
        <button onClick={() => (LIVE ? go('support') : openSheet({ kind: 'info', title: 'المساعدة', body: 'للمساعدة في الحجز أو التسجيل، تواصل مع فريق الدعم عبر halqa.app.eg@gmail.com. نرد عادة خلال يوم عمل.' }))}
          style={{ ...rowBtn, borderBottom: `1px solid ${color.divider}` }}><Icon name="help" size={18} /><span style={{ flex: 1, textAlign: 'right' }}>{LIVE ? 'الدعم والمساعدة' : 'المساعدة'}</span><Icon name="chevL" size={18} /></button>
        <button onClick={() => openSheet({ kind: 'info', title: 'الخصوصية', body: 'تسجيلاتك لا يطّلع عليها إلا معلمك المرتبط وإدارة الحلقة. يرى ولي الأمر بيانات أبنائه المرتبطين فقط. يُحذف التسجيل تلقائيًا بعد 48 ساعة من تقييم المعلم، وتبقى الدرجات والملاحظات. يمكنك طلب حذف تسجيلاتك في أي وقت.' })}
          style={rowBtn}><Icon name="shield" size={18} /><span style={{ flex: 1, textAlign: 'right' }}>الخصوصية</span><Icon name="chevL" size={18} /></button>
      </section>
      <button onClick={() => openSheet({ kind: 'confirm', title: 'تسجيل الخروج؟', body: 'ستحتاج إلى إدخال بريدك وكلمة المرور للعودة.', ok: 'تسجيل الخروج', danger: true, onOk: logout })}
        style={dangerOutlineBtn(52, 16)}><Icon name="leave" /> تسجيل الخروج</button>
      <p style={{ margin: 0, fontSize: 12, color: color.muted, textAlign: 'center', fontFamily: font.latin }}>{LIVE ? 'HALQA · v0.1' : 'HALQA · v0.1 prototype'}</p>
    </div>
  );
}

/** «تأكيد رقم الهاتف»: a verified number becomes a second way to sign in (with the same password). The current
 *  verified number stays until the new one is confirmed. Hidden when no SMS provider is configured. */
function PhoneRow() {
  const available = useApp((st) => st.pub.phone_verification);
  const [me, setMe] = useState<E.Me | null>(null);
  const [step, setStep] = useState<'view' | 'number' | 'code'>('view');
  const [num, setNum] = useState(''); const [code, setCode] = useState(''); const [sentTo, setSentTo] = useState('');
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [wait, setWait] = useState(0);
  useEffect(() => { let on = true; E.me().then((m) => on && setMe(m)).catch(() => {}); return () => { on = false; }; }, []);
  useEffect(() => { if (wait <= 0) return; const t = setTimeout(() => setWait((w) => w - 1), 1000); return () => clearTimeout(t); }, [wait]);
  if (!available || !me) return null;
  const send = async (e?: FormEvent) => {
    e?.preventDefault(); if (busy) return;
    if (num.trim().length < 8) return setErr('اكتب رقم هاتفك، مثل 01012345678.');
    setBusy(true); setErr(null);
    try { const r = await E.phoneStart(num.trim()); setSentTo(r.phone); setWait(r.resend_in); setCode(''); setStep('code'); }
    catch (x) { const a = x as ApiError; setErr(a.field?.('phone') ?? a.message); const w = Number(a.fields?.resend_in?.[0]); if (w) setWait(w); }
    finally { setBusy(false); }
  };
  const confirm = async (e: FormEvent) => {
    e.preventDefault(); if (busy) return;
    if (!/^\d{6}$/.test(code)) return setErr('أدخل الرمز المكوّن من 6 أرقام.');
    setBusy(true); setErr(null);
    try { setMe(await E.phoneConfirm(code)); setStep('view'); toast('تم تأكيد رقم الهاتف. يمكنك الدخول به مع كلمة المرور نفسها.'); }
    catch (x) { setErr((x as ApiError).message); }
    finally { setBusy(false); }
  };
  return (
    <section aria-labelledby="phone-h" style={{ ...card, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 id="phone-h" style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>تأكيد رقم الهاتف</h2>
      {step === 'view' && <>
        <p style={{ margin: 0, fontSize: 14, color: color.muted, lineHeight: 1.7 }}>
          {me.phone_verified ? <>رقمك المؤكد: <bdi dir="ltr" style={{ fontFamily: font.latin }}>{me.phone}</bdi>. يمكنك الدخول به أو بالبريد مع كلمة المرور نفسها.</>
            : 'أكّد رقم هاتفك لتتمكن من الدخول به بدل البريد. استعادة كلمة المرور تبقى عبر البريد.'}
        </p>
        <button onClick={() => { setStep('number'); setErr(null); setNum(''); }} style={outlineBtn(48, 15)}>{me.phone_verified ? 'تغيير الرقم' : 'تأكيد رقم الهاتف'}</button>
      </>}
      {step === 'number' && <form noValidate onSubmit={send} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label htmlFor="ph-num" style={labelStyle}>رقم الهاتف</label>
        <input id="ph-num" type="tel" inputMode="tel" dir="ltr" autoComplete="tel" value={num} placeholder="01012345678" onChange={(e) => setNum(e.target.value)} style={inputStyle(err, true)} />
        {me.phone_verified && <span style={{ fontSize: 13, color: color.muted }}>يبقى رقمك الحالي فعّالًا حتى تؤكد الرقم الجديد.</span>}
        <FieldError msg={err} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" disabled={busy || wait > 0} style={{ ...primaryBtn(48, 15), flex: 1 }}>{busy ? 'جارٍ الإرسال…' : wait > 0 ? `انتظر ${wait} ث` : 'إرسال رمز التأكيد'}</button>
          <button type="button" onClick={() => setStep('view')} style={outlineBtn(48, 15)}>إلغاء</button>
        </div>
      </form>}
      {step === 'code' && <form noValidate onSubmit={confirm} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p style={{ margin: 0, fontSize: 14 }}>أرسلنا رمزًا من 6 أرقام إلى <bdi dir="ltr" style={{ fontFamily: font.latin }}>{sentTo}</bdi>. صالح 5 دقائق.</p>
        <label htmlFor="ph-code" style={labelStyle}>رمز التأكيد</label>
        <input id="ph-code" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={inputStyle(err, true)} />
        <FieldError msg={err} />
        <button type="submit" disabled={busy} style={primaryBtn(48, 15)}>{busy ? 'جارٍ التحقق…' : 'تأكيد'}</button>
        <button type="button" disabled={busy || wait > 0} onClick={() => void send()} style={outlineBtn(44, 14)}>{wait > 0 ? `إعادة الإرسال بعد ${wait} ث` : 'إعادة إرسال الرمز'}</button>
      </form>}
    </section>
  );
}

/** «الإشعارات»: saved on the server in live mode, where phone notifications follow it (account notices always arrive). */
function setNotif(k: string, on: boolean) {
  const prev = useApp.getState().notif;
  up('notif', { [k]: on });
  if (LIVE) E.updateMe({ notify_prefs: { [k]: on } }).catch(() => { up('notif', prev); toast('تعذّر حفظ إعداد الإشعارات', 'alert'); });
}

/** Offers to install the PWA on the home screen; hidden when already installed or unsupported. */
function InstallRow() {
  const how = useInstall();
  if (!how) return null;
  const click = async () => {
    if (how === 'prompt') { if (await promptInstall()) toast('ثُبّت التطبيق على جهازك'); return; }
    openSheet({ kind: 'info', ...INSTALL_STEPS[how] });
  };
  return (
    <button onClick={click} style={{ ...card, minHeight: 56, padding: '0 16px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', color: color.ink, fontSize: 15, fontWeight: 700, textAlign: 'right' }}>
      <span style={{ color: color.primary }}><Icon name="upload" size={18} /></span>
      <span style={{ flex: 1 }}>ثبّت التطبيق على جهازك</span>
      <span style={{ color: color.primary }}><Icon name="chevL" size={18} /></span>
    </button>
  );
}


/** What this device really does (permission + subscription + the server's record), in the owner's words. */
const PUSH: Record<PushState, { head: string; text: string; tone: 'ok' | 'warn' | 'muted' }> = {
  'on': { head: 'الإشعارات مفعلة', tone: 'ok', text: 'ستصلك الإشعارات على هذا الجهاز حتى عند إغلاق التطبيق. تظهر على شاشة القفل تنبيهات عامة فقط، والتفاصيل داخل التطبيق.' },
  'off': { head: 'هذا الجهاز غير مشترك في الإشعارات', tone: 'warn', text: 'فعّلها لتصلك تنبيهات الواجبات والتقييمات والجلسات على هذا الجهاز، دون تفاصيل على شاشة القفل.' },
  'denied': { head: 'تم رفض إذن الإشعارات من إعدادات الجهاز', tone: 'warn',
    text: 'لتفعيلها: على Android افتح إعدادات الهاتف ← التطبيقات ← الحلقة (أو Chrome) ← الإشعارات ← السماح. على الكمبيوتر اضغط رمز القفل بجانب عنوان الموقع ← الإشعارات ← السماح. ثم ارجع إلى هنا.' },
  'ios-install': { head: 'الإشعارات غير مفعلة', tone: 'muted',
    text: 'على iPhone وiPad تعمل الإشعارات بعد تثبيت الحلقة: افتحها في Safari ← زر المشاركة ← «إضافة إلى الشاشة الرئيسية»، ثم افتح الحلقة من أيقونتها وفعّل الإشعارات من هنا (iOS 16.4 أو أحدث).' },
  'server-off': { head: 'الإشعارات غير مفعلة', tone: 'muted', text: 'إشعارات الجوال غير متاحة على الخادم حاليًا. ستجد كل الإشعارات داخل التطبيق.' },
  'unsupported': { head: 'الإشعارات غير مفعلة', tone: 'muted', text: 'هذا المتصفح لا يدعم إشعارات الويب. استخدم Chrome أو Edge، أو ثبّت التطبيق. ستجد كل الإشعارات داخل التطبيق.' },
};

/** «تفعيل الإشعارات» for this device: the permission is asked only when the button is tapped. */
function PushRow() {
  const [st, setSt] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { pushState().then(setSt).catch(() => setSt('unsupported')); }, []);
  if (!st) return <p role="status" style={{ margin: '4px 0', fontSize: 13, color: color.muted }}>جارٍ التحقق من إشعارات هذا الجهاز…</p>;
  const act = async (on: boolean) => {
    setBusy(true); setErr(null);
    try {
      const n = on ? await enablePush() : await disablePush();
      setSt(n);
      if (n === 'on') toast('ستصلك الإشعارات على هذا الجهاز');
      if (!on) toast('أُوقفت الإشعارات على هذا الجهاز');
    } catch (e) { setErr(e instanceof PushError ? e.message : 'تعذّر تغيير الإشعارات. تحقق من الاتصال وحاول مرة أخرى.'); }
    finally { setBusy(false); }
  };
  const p = PUSH[st];
  const ink = p.tone === 'ok' ? color.primary : p.tone === 'warn' ? color.warnInk : color.ink;
  return (
    <div aria-labelledby="push-h" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '6px 0 12px', borderBottom: `1px solid ${color.divider}` }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: ink }}><Icon name="bell" size={18} /></span>
        <strong id="push-h" role="status" style={{ fontSize: 15, color: ink }}>{p.head}</strong>
      </span>
      <p style={{ margin: 0, fontSize: 13, color: color.muted, lineHeight: 1.7 }}>{p.text}</p>
      {st === 'off' && <button onClick={() => void act(true)} disabled={busy} style={primaryBtn(48, 15)}>{busy ? 'جارٍ التفعيل…' : 'تفعيل الإشعارات'}</button>}
      {st === 'on' && <button onClick={() => void act(false)} disabled={busy} style={outlineBtn(44, 14)}>{busy ? 'جارٍ الإيقاف…' : 'إيقاف الإشعارات على هذا الجهاز'}</button>}
      {st === 'denied' && <button onClick={() => { setSt(null); pushState().then(setSt).catch(() => setSt('unsupported')); }} style={outlineBtn(44, 14)}>أعد التحقق بعد تغيير الإعدادات</button>}
      {err && <p role="alert" style={{ margin: 0, fontSize: 13, color: color.dangerInk }}>{err}</p>}
    </div>
  );
}
