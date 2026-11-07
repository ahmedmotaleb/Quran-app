/** «فعّل تذكيرات القرآن الكريم»: a bottom sheet on the student's home (live mode) asking to turn on notifications for
 *  the daily Quran reminders. The browser's permission prompt opens only from «تفعيل الإشعارات» (a tap).
 *  - Shown only when this device is not subscribed and permission was never refused, after the home screen settles.
 *  - «ليس الآن» hides it for 7 days. A refusal (now or earlier) is never asked again: the sheet shows once how to
 *    allow it in the device settings, then never returns.
 *  - iPhone/iPad not installed to the Home Screen: Web Push needs the installed app, so the sheet explains that first.
 *  While it is shown the install sheet steps aside (one bottom sheet at a time). */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { color } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { primaryBtn } from '@/components/ui';
import { toast } from '@/store/store';
import { PushError, enablePush, pushState } from './push';

const LATER_KEY = 'halqa.reminderPrompt.later';
const DENIED_KEY = 'halqa.reminderPrompt.denied';
const COOLDOWN_DAYS = 7;
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

// One bottom sheet at a time: the install sheet reads this and stays hidden while the reminder sheet is up.
let shown = false; const subs = new Set<() => void>();
const setShown = (v: boolean) => { if (shown !== v) { shown = v; subs.forEach((f) => f()); } };
export const useReminderPromptShown = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => shown, () => false);

type Mode = 'ask' | 'ios' | 'denied' | null;

export function ReminderPrompt() {
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => {
    if (read(DENIED_KEY) || Date.now() - Number(read(LATER_KEY) || 0) < COOLDOWN_DAYS * 86_400_000) return;
    let on = true;
    // After the home screen settles, never on top of the first paint.
    const t = setTimeout(() => {
      pushState().then((st) => {
        if (!on) return;
        if (st === 'off') setMode('ask');
        else if (st === 'ios-install') setMode('ios');
        else if (st === 'denied') write(DENIED_KEY, '1'); // refused earlier: never ask
      }).catch(() => {});
    }, 1500);
    return () => { on = false; clearTimeout(t); };
  }, []);
  useEffect(() => { setShown(!!mode); return () => setShown(false); }, [mode]);
  if (!mode) return null;

  const later = () => { write(LATER_KEY, String(Date.now())); setMode(null); };
  const enable = async () => {
    setBusy(true); setErr('');
    try {
      const st = await enablePush();
      if (st === 'on') { toast('فُعّلت تذكيرات القرآن على هذا الجهاز'); setMode(null); }
      else if (st === 'denied') { write(DENIED_KEY, '1'); setMode('denied'); }
      else if (st === 'ios-install') setMode('ios');
      else setMode(null);
    } catch (e) { setErr(e instanceof PushError ? e.message : 'تعذّر تفعيل الإشعارات. حاول مرة أخرى من «حسابي».'); }
    finally { setBusy(false); }
  };
  const step = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, lineHeight: 1.6 } as const;
  const badge = { width: 30, height: 30, borderRadius: 8, background: color.sageTint, color: color.primary, display: 'grid', placeItems: 'center', flexShrink: 0 } as const;
  const text = mode === 'ask' ? 'هنفكّرك بورد القراءة والمراجعة والحفظ في الأوقات اللي تختارها، حتى لو التطبيق مقفول.'
    : mode === 'ios' ? 'على iPhone وiPad تصل الإشعارات إلى التطبيق المثبّت فقط. ثبّت الحلقة أولًا، ثم افتحها من الشاشة الرئيسية وفعّل الإشعارات.'
    : 'رُفض إذن الإشعارات لهذا الموقع، فلن نسألك مرة أخرى. لتفعيلها لاحقًا: على Android افتح الإعدادات ← التطبيقات ← الحلقة (أو Chrome) ← الإشعارات ← السماح. على الكمبيوتر اضغط رمز القفل بجانب العنوان ← الإشعارات ← السماح.';

  return (
    <section role="region" aria-labelledby="rem-prompt-title" data-testid="reminder-sheet"
      style={{ flexShrink: 0, margin: '0 10px 8px', padding: 14, background: color.card, border: `1px solid ${color.border}`, borderRadius: 18,
        boxShadow: '0 -6px 24px -12px rgba(0,0,0,.25)', display: 'flex', flexDirection: 'column', gap: 12, animation: 'hqrise .28s ease-out' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{ width: 48, height: 48, borderRadius: 12, background: color.sage, color: color.primary, display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="bell" /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 id="rem-prompt-title" style={{ margin: 0, fontSize: 17, fontWeight: 800, color: color.ink }}>فعّل تذكيرات القرآن الكريم</h2>
          <p style={{ margin: '4px 0 0', fontSize: 14, lineHeight: 1.7, color: color.body }}>{text}</p>
        </div>
        <button onClick={later} aria-label="إغلاق" style={{ width: 44, height: 44, margin: '-8px -8px 0 0', border: 'none', background: 'transparent', color: color.muted, display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0 }}>
          <Icon name="x" size={20} />
        </button>
      </div>
      {mode === 'ios' && (
        <ol aria-label="خطوات التثبيت" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <li style={step}><span style={badge}><Icon name="share" size={18} /></span>١. اضغط زر المشاركة في Safari</li>
          <li style={step}><span style={badge}><Icon name="addSquare" size={18} /></span>٢. اختر «إضافة إلى الشاشة الرئيسية» ثم افتح الحلقة من هناك</li>
        </ol>
      )}
      {err && <p role="alert" style={{ margin: 0, color: color.dangerInk, fontSize: 14 }}>{err}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        {mode === 'ask' && <button onClick={() => void enable()} disabled={busy} aria-busy={busy} style={primaryBtn(48, 15, { flex: 1, borderRadius: 12, opacity: busy ? 0.7 : 1 })}>
          <Icon name="bell" size={18} /> تفعيل الإشعارات</button>}
        <button onClick={mode === 'denied' ? () => setMode(null) : later}
          style={{ minHeight: 48, padding: '0 18px', borderRadius: 12, border: `1px solid ${color.borderStrong}`, background: 'transparent', color: color.primary, fontSize: 15, fontWeight: 700, cursor: 'pointer', ...(mode !== 'ask' ? { flex: 1 } : {}) }}>
          {mode === 'denied' ? 'حسنًا' : 'ليس الآن'}
        </button>
      </div>
    </section>
  );
}
