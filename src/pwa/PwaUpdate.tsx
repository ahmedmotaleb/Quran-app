/** Registers the service worker and offers new versions without interrupting the user. "Update now" never
 *  reloads over a recording: while one is being made, reviewed, uploaded or waiting for a retry, the update waits and
 *  applies itself once the recording is sent or discarded. */
import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useApp } from '@/store/store';
import { recorderActive } from '@/services/media';
import { voiceNote, voiceNoteRecording } from '@/services/voiceNote';
import { color } from '@/theme/tokens';

const BUSY = new Set(['requesting', 'recording', 'paused', 'review', 'uploading', 'failed']);

/** Activate the waiting version and reload into it. vite-plugin-pwa reloads only on a `controlling` event with
 *  isUpdate, which never comes when this page was not controlled by a service worker (the first visit in a browser):
 *  the new version activated but the page stayed, and «حدّث الآن» did nothing (owner report 15 Nov 2026). Here the
 *  reload follows whichever comes first: the controller change, the waiting worker activating, or 4 s. */
export async function applyUpdate() {
  let done = false;
  const reload = () => { if (!done) { done = true; window.location.reload(); } };
  const sw = navigator.serviceWorker;
  const reg = await sw?.getRegistration().catch(() => undefined);
  sw?.addEventListener('controllerchange', reload, { once: true });
  const waiting = reg?.waiting;
  if (waiting) {
    waiting.addEventListener('statechange', () => { if (waiting.state === 'activated') reload(); });
    waiting.postMessage({ type: 'SKIP_WAITING' });
    setTimeout(reload, 4000);
  } else reload();   // already activated (e.g. by another tab): the reload loads it
}

export default function PwaUpdate() {
  const { needRefresh: [needRefresh, setNeedRefresh] } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      // Check for a new version every hour while the app stays open.
      if (reg) setInterval(() => { reg.update().catch(() => {}); }, 60 * 60 * 1000);
    },
  });
  const recBusy = useApp((s) => BUSY.has(s.rec.phase));
  const [waiting, setWaiting] = useState(false);
  const [applying, setApplying] = useState(false);
  const update = () => { setApplying(true); void applyUpdate(); };
  const busy = () => recBusy || recorderActive() || voiceNoteRecording() || !!voiceNote.blob; // a teacher's unsent voice note too
  // The admin portal has no recordings to protect: a new version applies at once instead of waiting for a tap.
  const admin = typeof window !== 'undefined' && window.location.pathname.startsWith('/admin');
  useEffect(() => { if (admin && needRefresh) void applyUpdate(); }, [admin, needRefresh]);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => { if (!busy()) { clearInterval(t); void applyUpdate(); } }, 1000);
    return () => clearInterval(t);
  }); // re-evaluated on every render so it sees the latest recording state
  if (!needRefresh || admin) return null;
  return (
    // While waiting, the notice moves to the top and lets taps through, so it never covers the recorder's own
    // buttons (the submit button sits at the bottom of the screen).
    <div role="status" dir="rtl" lang="ar" style={{ position: 'fixed', insetInline: 12, zIndex: 1000,
      ...(waiting ? { top: 'calc(8px + env(safe-area-inset-top))', pointerEvents: 'none', opacity: 0.95 } : { bottom: 'calc(12px + env(safe-area-inset-bottom))' }), background: color.primary, color: color.ivory, borderRadius: 14, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 10px 30px -10px rgba(0,0,0,.4)', maxWidth: 480, marginInline: 'auto' }}>
      <span style={{ flex: 1, fontSize: 14, fontWeight: 700 }}>
        {applying ? 'جارٍ التحديث…' : waiting ? 'سيُحدَّث التطبيق تلقائيًا بعد إرسال تسجيلك أو حذفه.' : 'يتوفر إصدار جديد من التطبيق.'}
      </span>
      {!waiting && !applying && <button onClick={() => setNeedRefresh(false)} style={{ minHeight: 40, padding: '0 10px', border: 'none', background: 'transparent', color: color.ivory, fontSize: 13, cursor: 'pointer' }}>لاحقًا</button>}
      {!waiting && !applying && (
        <button onClick={() => (busy() ? setWaiting(true) : update())} style={{ minHeight: 40, padding: '0 14px', borderRadius: 10, border: 'none', background: color.ivory, color: color.primary, fontWeight: 800, cursor: 'pointer' }}>حدّث الآن</button>
      )}
    </div>
  );
}
