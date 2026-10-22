/** Registers the service worker and offers new versions without interrupting the user. "Update now" never
 *  reloads over a recording: while one is being made, reviewed, uploaded or waiting for a retry, the update waits and
 *  applies itself once the recording is sent or discarded. The admin portal (no recording there) updates itself as soon
 *  as a new version is found, and checks on every open, so admins never keep working on an old portal. */
import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useApp } from '@/store/store';
import { recorderActive } from '@/services/media';
import { voiceNote, voiceNoteRecording } from '@/services/voiceNote';
import { color } from '@/theme/tokens';

const ADMIN = () => window.location.pathname.startsWith('/admin');
const BUSY = new Set(['requesting', 'recording', 'paused', 'review', 'uploading', 'failed']);

export default function PwaUpdate() {
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      // Check for a new version every hour while the app stays open.
      if (!reg) return;
      if (ADMIN()) reg.update().catch(() => {}); // the portal checks right away, not only after an hour
      setInterval(() => { reg.update().catch(() => {}); }, (ADMIN() ? 5 : 60) * 60 * 1000);
    },
  });
  const recBusy = useApp((s) => BUSY.has(s.rec.phase));
  const [waiting, setWaiting] = useState(false);
  const busy = () => recBusy || recorderActive() || voiceNoteRecording() || !!voiceNote.blob; // a teacher's unsent voice note too
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => { if (!busy()) { clearInterval(t); updateServiceWorker(true); } }, 1000);
    return () => clearInterval(t);
  }); // re-evaluated on every render so it sees the latest recording state
  useEffect(() => { if (needRefresh && ADMIN()) void updateServiceWorker(true); }, [needRefresh, updateServiceWorker]);
  if (!needRefresh) return null;
  if (ADMIN()) return <div role="status" dir="rtl" lang="ar" style={{ position: 'fixed', top: 8, insetInline: 12, zIndex: 1000, background: color.primary, color: color.ivory, borderRadius: 12, padding: '8px 12px', textAlign: 'center', fontSize: 14, fontWeight: 700, maxWidth: 360, marginInline: 'auto' }}>جارٍ تحديث لوحة الإدارة…</div>;
  return (
    // While waiting, the notice moves to the top and lets taps through, so it never covers the recorder's own
    // buttons (the submit button sits at the bottom of the screen).
    <div role="status" dir="rtl" lang="ar" style={{ position: 'fixed', insetInline: 12, zIndex: 1000,
      ...(waiting ? { top: 'calc(8px + env(safe-area-inset-top))', pointerEvents: 'none', opacity: 0.95 } : { bottom: 'calc(12px + env(safe-area-inset-bottom))' }), background: color.primary, color: color.ivory, borderRadius: 14, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 10px 30px -10px rgba(0,0,0,.4)', maxWidth: 480, marginInline: 'auto' }}>
      <span style={{ flex: 1, fontSize: 14, fontWeight: 700 }}>
        {waiting ? 'سيُحدَّث التطبيق تلقائيًا بعد إرسال تسجيلك أو حذفه.' : 'يتوفر إصدار جديد من التطبيق.'}
      </span>
      {!waiting && <button onClick={() => setNeedRefresh(false)} style={{ minHeight: 40, padding: '0 10px', border: 'none', background: 'transparent', color: color.ivory, fontSize: 13, cursor: 'pointer' }}>لاحقًا</button>}
      {!waiting && (
        <button onClick={() => (busy() ? setWaiting(true) : updateServiceWorker(true))} style={{ minHeight: 40, padding: '0 14px', borderRadius: 10, border: 'none', background: color.ivory, color: color.primary, fontWeight: 800, cursor: 'pointer' }}>حدّث الآن</button>
      )}
    </div>
  );
}
