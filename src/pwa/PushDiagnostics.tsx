/** «حالة الإشعارات على هذا الجهاز» (حسابي ← الإشعارات): every link of the push chain on THIS device, read live —
 *  browser support, permission, service worker, push subscription (host only), whether the server has this exact
 *  device for this account, the server's readiness, preferences, reminder times and the last daily reminder sent.
 *  No keys or endpoints are shown. «ربط الجهاز بالإشعارات» repairs the subscription (success only after the server
 *  confirms it); «إرسال إشعار تجريبي» sends a real push to this account's devices. Used in the learners' «حسابي»
 *  (every role) and on the admin portal's overview (administrators), so it imports nothing from either app's store. */
import { useEffect, useState } from 'react';
import { color } from '@/theme/tokens';
import { outlineBtn, primaryBtn } from '@/components/ui';
import { ApiError } from '@/api/client';
import { deviceZone, fmtShortDateTime, hourLabel } from '@/lib/time';
import { PushError, connectDevice, diagnosePush, selfTest, type PushDiag } from './push';

type Row = [label: string, value: string, ok: boolean | null];
const KIND: Record<string, string> = { reminder_reading: 'ورد القراءة', reminder_hifz: 'الحفظ', reminder_review: 'المراجعة', reminder_evening: 'تذكير آخر اليوم' };
const SERVER: Record<string, string> = { ready: 'جاهز', not_configured: 'غير مضبوط', misconfigured: 'مفاتيح غير متطابقة', unreachable: 'تعذّر الوصول' };

function rows(d: PushDiag): Row[] {
  const tz = deviceZone();
  const r: Row[] = [
    ['دعم المتصفح', d.supported.sw && d.supported.push && d.supported.notification ? 'مدعوم' : `غير مدعوم (${[!d.supported.sw && 'Service Worker', !d.supported.push && 'Push', !d.supported.notification && 'Notification'].filter(Boolean).join('، ')})`, d.supported.sw && d.supported.push && d.supported.notification],
    ['إذن الإشعارات', d.permission === 'granted' ? 'مسموح' : d.permission === 'denied' ? 'مرفوض' : d.permission === 'default' ? 'لم يُطلب بعد' : 'غير مدعوم', d.permission === 'granted' ? true : d.permission === 'default' ? null : false],
    ['التطبيق مثبّت', d.standalone ? 'نعم (يعمل كتطبيق)' : 'لا (يعمل في المتصفح)', null],
    ['خدمة التطبيق (Service Worker)', d.sw === 'active' ? (d.controlled ? 'تعمل' : 'تعمل (أعد فتح التطبيق لتتحكم بالصفحة)') : d.sw === 'installing' ? 'جارٍ التثبيت' : 'غير مثبّتة', d.sw === 'active'],
    ['اشتراك هذا الجهاز', d.subscription ? `موجود${d.subscriptionHost ? ` (${d.subscriptionHost})` : ''}${d.keyMatches === false ? ' — بمفتاح قديم' : ''}` : 'غير موجود', d.subscription && d.keyMatches !== false],
    ['مسجّل على الخادم لهذا الحساب', d.registered == null ? '—' : d.registered ? 'نعم' : 'لا', d.registered],
    ['إشعارات الخادم', `${SERVER[d.server] ?? d.server}${d.publicKey ? '' : ' (لا مفتاح عام)'}`, d.server === 'ready' && d.publicKey],
    ['أجهزة هذا الحساب', String(d.devices), d.devices > 0],
  ];
  if (d.lastSuccessAt) r.push(['آخر إرسال ناجح لهذا الجهاز', fmtShortDateTime(d.lastSuccessAt, tz), true]);
  if (d.lastFailure) r.push(['آخر خطأ لهذا الجهاز', d.lastFailure, false]);
  if (d.prefs.reminders === false) r.push(['تذكيرات القرآن', 'متوقفة من «الإشعارات» أعلاه', false]);
  if (d.reminders) {
    const on = (['reading', 'hifz', 'review', 'evening'] as const).filter((k) => d.reminders![k]?.on).map((k) => `${KIND['reminder_' + k]} ${hourLabel(d.reminders![k].hour)}`);
    r.push(['التذكيرات اليومية', on.length ? on.join('، ') : 'كلها متوقفة', on.length > 0]);
    if (d.reminders.quiet) r.push(['ساعات الهدوء', `${hourLabel(d.reminders.quiet[0])} – ${hourLabel(d.reminders.quiet[1])}`, null]);
  }
  if (d.timezone) r.push(['المنطقة الزمنية للحساب', d.timezone === tz ? d.timezone : `${d.timezone} (الجهاز: ${tz})`, d.timezone === tz]);
  if (d.reminders) r.push(['آخر تذكير يومي أُرسل', d.lastReminder ? `${KIND[d.lastReminder.kind] ?? d.lastReminder.kind} · ${fmtShortDateTime(d.lastReminder.at, tz)}` : 'لم يُرسل بعد', null]);
  if (d.promptRefused) r.push(['شريط التفعيل', 'مخفي (رُفض الإذن سابقًا)', null]);
  else if (d.promptLater && Date.now() - d.promptLater < 7 * 86_400_000) r.push(['شريط التفعيل', `مؤجل منذ ${fmtShortDateTime(new Date(d.promptLater).toISOString(), tz)}`, null]);
  return r;
}

export function PushDiagnostics({ title = 'حالة الإشعارات على هذا الجهاز' }: { title?: string } = {}) {
  const [d, setD] = useState<PushDiag | null>(null);
  const [busy, setBusy] = useState<'connect' | 'test' | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const load = () => diagnosePush().then(setD).catch(() => setD(null));
  useEffect(() => { void load(); }, []);
  if (!d) return <p role="status" style={{ margin: '6px 0', fontSize: 13, color: color.muted }}>جارٍ فحص الإشعارات على هذا الجهاز…</p>;
  const broken = d.permission === 'granted' && (!d.subscription || d.registered === false || d.keyMatches === false);
  const connect = async () => {
    setBusy('connect'); setMsg(null);
    try { await connectDevice(); setMsg({ text: 'رُبط هذا الجهاز وأكّد الخادم تسجيله.', ok: true }); }
    catch (e) { setMsg({ text: e instanceof PushError ? e.message : 'تعذّر ربط الجهاز.', ok: false }); }
    finally { setBusy(null); void load(); }
  };
  const test = async () => {
    setBusy('test'); setMsg(null);
    try { const r = await selfTest(); setMsg({ text: r.message, ok: r.this_device_sent || (!r.this_device && r.sent > 0) }); }
    catch (e) { setMsg({ text: e instanceof ApiError ? e.message : 'تعذّر الإرسال.', ok: false }); }
    finally { setBusy(null); void load(); }
  };
  return (
    <section aria-labelledby="pd-h" data-testid="push-diagnostics" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0 12px' }}>
      <h3 id="pd-h" style={{ margin: 0, fontSize: 14, fontWeight: 800 }}>{title}</h3>
      {broken && <p role="alert" style={{ margin: 0, padding: '8px 10px', borderRadius: 10, background: color.warnBg, color: color.warnInk, fontSize: 14, lineHeight: 1.7 }}>
        إشعارات الهاتف مسموحة، لكن هذا الجهاز غير متصل بخدمة الإشعارات.</p>}
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 10px', fontSize: 13 }}>
        {rows(d).map(([k, v, ok]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt style={{ color: color.muted }}>{k}</dt>
            <dd style={{ margin: 0, fontWeight: 700, color: ok === true ? color.primary : ok === false ? color.dangerInk : color.ink }}>{ok === true ? '✓ ' : ok === false ? '✗ ' : ''}{v}</dd>
          </div>
        ))}
      </dl>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(broken || d.permission === 'default') && d.server === 'ready' && (
          <button onClick={() => void connect()} disabled={!!busy} style={primaryBtn(48, 15, { flex: '1 1 200px' })}>{busy === 'connect' ? 'جارٍ الربط…' : 'ربط الجهاز بالإشعارات'}</button>)}
        <button onClick={() => void test()} disabled={!!busy || d.server !== 'ready'} style={outlineBtn(48, 14, { flex: '1 1 160px' })}>{busy === 'test' ? 'جارٍ الإرسال…' : 'إرسال إشعار تجريبي'}</button>
        <button onClick={() => { setD(null); void load(); }} disabled={!!busy} style={outlineBtn(48, 14, { flex: '0 1 120px' })}>إعادة الفحص</button>
      </div>
      {msg && <p role="status" style={{ margin: 0, fontSize: 13, lineHeight: 1.7, color: msg.ok ? color.primary : color.dangerInk }}>{msg.text}</p>}
      <p style={{ margin: 0, fontSize: 12, color: color.muted, lineHeight: 1.7 }}>
        «قبلت خدمة الإشعارات» يعني أن Google استلمت الإشعار؛ ظهوره على الهاتف يتحكم فيه Android (إعدادات الإشعارات وتوفير البطارية).</p>
    </section>
  );
}
