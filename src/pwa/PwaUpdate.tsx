/** Registers the service worker and offers new versions without interrupting the user (e.g. mid-recording). */
import { useRegisterSW } from 'virtual:pwa-register/react';
import { color } from '@/theme/tokens';

export default function PwaUpdate() {
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      // Check for a new version every hour while the app stays open.
      if (reg) setInterval(() => { reg.update().catch(() => {}); }, 60 * 60 * 1000);
    },
  });
  if (!needRefresh) return null;
  return (
    <div role="status" dir="rtl" lang="ar" style={{ position: 'fixed', insetInline: 12, bottom: 'calc(12px + env(safe-area-inset-bottom))', zIndex: 1000, background: color.primary, color: color.ivory, borderRadius: 14, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 10px 30px -10px rgba(0,0,0,.4)', maxWidth: 480, marginInline: 'auto' }}>
      <span style={{ flex: 1, fontSize: 14, fontWeight: 700 }}>يتوفر إصدار جديد من التطبيق.</span>
      <button onClick={() => setNeedRefresh(false)} style={{ minHeight: 40, padding: '0 10px', border: 'none', background: 'transparent', color: color.ivory, fontSize: 13, cursor: 'pointer' }}>لاحقًا</button>
      <button onClick={() => updateServiceWorker(true)} style={{ minHeight: 40, padding: '0 14px', borderRadius: 10, border: 'none', background: color.ivory, color: color.primary, fontWeight: 800, cursor: 'pointer' }}>حدّث الآن</button>
    </div>
  );
}
