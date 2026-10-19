/** A visible, dismissible "install the app" suggestion on the main screens, for every role. The browser's own
 *  banner is held back (install.ts keeps its event for our button), so this is the suggestion people see. */
import { useState } from 'react';
import { color } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { openSheet, toast } from '@/store/store';
import { INSTALL_STEPS, promptInstall, useInstall } from './install';

const KEY = 'halqa.install.dismissed';
const QUIET_DAYS = 14;
function dismissedRecently() {
  try { const t = Number(localStorage.getItem(KEY) || 0); return Date.now() - t < QUIET_DAYS * 86_400_000; } catch { return false; }
}

export function InstallBanner() {
  const how = useInstall();
  const [hidden, setHidden] = useState(dismissedRecently);
  if (!how || hidden) return null;
  const close = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch { /* private mode */ } setHidden(true); };
  const install = async () => {
    if (how === 'prompt') { if (await promptInstall()) { toast('ثُبّت التطبيق على جهازك'); setHidden(true); } return; }
    openSheet({ kind: 'info', ...INSTALL_STEPS[how] });
  };
  return (
    <div role="region" aria-label="تثبيت التطبيق" style={{ flexShrink: 0, background: color.sage, color: color.primary, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
      <img src="/icons/icon-192.png" alt="" width={32} height={32} style={{ borderRadius: 8, flexShrink: 0 }} />
      <span style={{ flex: 1, fontSize: 14, fontWeight: 700, lineHeight: 1.5 }}>ثبّت الحلقة على جهازك لتفتحها كتطبيق بضغطة واحدة</span>
      <button onClick={install} style={{ minHeight: 40, padding: '0 14px', borderRadius: 10, border: 'none', background: color.primary, color: color.ivory, fontSize: 14, fontWeight: 800, cursor: 'pointer', flexShrink: 0 }}>
        {how === 'prompt' ? 'تثبيت' : 'كيف؟'}
      </button>
      <button onClick={close} aria-label="إخفاء اقتراح التثبيت" style={{ width: 40, height: 40, border: 'none', background: 'transparent', color: color.primary, display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0 }}><Icon name="x" size={18} /></button>
    </div>
  );
}
