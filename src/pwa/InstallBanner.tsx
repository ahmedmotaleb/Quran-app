/** «ثبّت تطبيق الحلقة»: a bottom sheet on the main screens of a phone browser, above the tab bar and the safe area.
 *  - Android (Chrome, Edge, Samsung Internet…): shown only once the browser has offered installation
 *    (`beforeinstallprompt`); «تثبيت التطبيق» opens the browser's real install dialog.
 *  - iPhone/iPad: no install dialog exists, so the sheet explains Share → «إضافة إلى الشاشة الرئيسية».
 *  - Never when running installed (standalone / Home Screen), after the browser reported the install, on a desktop
 *    browser, or within 7 days of «لاحقًا» (or a cancelled install dialog).
 *  Installing never asks for notification permission: that stays a separate choice in «حسابي». */
import { useState, useSyncExternalStore } from 'react';
import { color } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { primaryBtn } from '@/components/ui';
import { toast } from '@/store/store';
import { hasInstallPrompt, isAndroid, isIos, isStandalone, onInstallChange, promptInstall, wasInstalled } from './install';

const LATER_KEY = 'halqa.install.later';
const OLD_KEY = 'halqa.install.dismissed'; // the previous top strip's «hide» time: still respected
export const COOLDOWN_DAYS = 7;

function laterRecently() {
  try {
    const t = Math.max(Number(localStorage.getItem(LATER_KEY) || 0), Number(localStorage.getItem(OLD_KEY) || 0));
    return Date.now() - t < COOLDOWN_DAYS * 86_400_000;
  } catch { return false; }
}
function rememberLater() { try { localStorage.setItem(LATER_KEY, String(Date.now())); } catch { /* private mode: hidden for this visit */ } }

// In-app browsers (Facebook, Instagram, Line…) cannot add to the Home Screen.
const inAppBrowser = () => /FBAN|FBAV|Instagram|Line\//i.test(navigator.userAgent);
const phone = () => isAndroid() || isIos() || /Mobi/i.test(navigator.userAgent);

type Mode = 'prompt' | 'ios' | null;
function mode(): Mode {
  if (typeof window === 'undefined' || isStandalone() || wasInstalled() || !phone()) return null;
  if (hasInstallPrompt()) return 'prompt';
  if (isIos() && !inAppBrowser()) return 'ios';
  return null;
}

export function InstallBanner() {
  const m = useSyncExternalStore(onInstallChange, mode, () => null);
  const [hidden, setHidden] = useState(laterRecently);
  const [busy, setBusy] = useState(false);
  if (!m || hidden) return null;

  const later = () => { rememberLater(); setHidden(true); };
  const install = async () => {
    setBusy(true);
    try {
      if (await promptInstall()) { toast('ثُبّت تطبيق الحلقة على جهازك'); setHidden(true); }
      else later(); // cancelled in the browser's dialog: ask again after the cooldown, not on the next screen
    } catch { later(); } finally { setBusy(false); }
  };
  const ios = m === 'ios';
  const step = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, lineHeight: 1.6 } as const;
  const badge = { width: 30, height: 30, borderRadius: 8, background: color.sageTint, color: color.primary, display: 'grid', placeItems: 'center', flexShrink: 0 } as const;

  return (
    <section role="region" aria-labelledby="install-title" data-testid="install-sheet"
      style={{ flexShrink: 0, margin: '0 10px 8px', padding: 14, background: color.card, border: `1px solid ${color.border}`, borderRadius: 18,
        boxShadow: '0 -6px 24px -12px rgba(0,0,0,.25)', display: 'flex', flexDirection: 'column', gap: 12, animation: 'hqrise .28s ease-out' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <img src="/icons/icon-192.png" alt="" width={48} height={48} style={{ borderRadius: 12, flexShrink: 0, boxShadow: '0 2px 6px rgba(0,0,0,.12)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 id="install-title" style={{ margin: 0, fontSize: 17, fontWeight: 800, color: color.ink }}>ثبّت تطبيق الحلقة</h2>
          <p style={{ margin: '4px 0 0', fontSize: 14, lineHeight: 1.7, color: color.body }}>
            {ios ? 'لتثبيت الحلقة على جهازك، اضغط زر المشاركة ثم اختر «إضافة إلى الشاشة الرئيسية».'
              : 'ثبّت التطبيق على جهازك للوصول بشكل أسرع واستقبال الإشعارات بسهولة.'}
          </p>
        </div>
        <button onClick={later} aria-label="إغلاق اقتراح التثبيت"
          style={{ width: 44, height: 44, margin: '-8px -8px 0 0', border: 'none', background: 'transparent', color: color.muted, display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0, borderRadius: 12 }}>
          <Icon name="x" size={20} />
        </button>
      </div>
      {ios && (
        <ol aria-label="خطوات التثبيت" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <li style={step}><span style={badge}><Icon name="share" size={18} /></span>١. اضغط زر المشاركة في شريط المتصفح</li>
          <li style={step}><span style={badge}><Icon name="addSquare" size={18} /></span>٢. اختر «إضافة إلى الشاشة الرئيسية» ثم «إضافة»</li>
        </ol>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        {!ios && (
          <button onClick={install} disabled={busy} aria-busy={busy} style={primaryBtn(48, 15, { flex: 1, borderRadius: 12, opacity: busy ? 0.7 : 1 })}>
            <Icon name="download" size={18} /> تثبيت التطبيق
          </button>
        )}
        <button onClick={later}
          style={{ minHeight: 48, padding: '0 18px', borderRadius: 12, border: `1px solid ${color.borderStrong}`, background: 'transparent', color: color.primary, fontSize: 15, fontWeight: 700, cursor: 'pointer', ...(ios ? { flex: 1 } : {}) }}>
          لاحقًا
        </button>
      </div>
    </section>
  );
}
