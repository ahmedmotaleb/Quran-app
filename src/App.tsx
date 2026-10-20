import { lazy, Suspense, useEffect, useState } from 'react';
import AppShell from './AppShell';
import DemoPanel from './demo/DemoPanel';
import { startSplash, tick, useApp } from './store/store';
import PwaUpdate from './pwa/PwaUpdate';
import { isStandalone } from './pwa/install';
import { LIVE } from './api/client';

const AdminApp = lazy(() => import('./admin/AdminApp'));
import { parentLoginEntry } from '@/store/store';
const DesignSystem = lazy(() => import('./designsystem/DesignSystem'));
const SetPasswordPage = lazy(() => import('./screens/auth/LinkPages').then((m) => ({ default: m.SetPasswordPage })));
const AcceptInvitePage = lazy(() => import('./screens/auth/LinkPages').then((m) => ({ default: m.AcceptInvitePage })));

function useHash() {
  const [h, setH] = useState(() => window.location.hash);
  useEffect(() => { const on = () => setH(window.location.hash); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  return h;
}

const FRAME_QUERY = '(min-width: 760px)';

function useMedia(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q); const on = () => setM(mq.matches);
    mq.addEventListener('change', on); return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

/** `#/parent` → app on the parent sign-in, `#/admin` → admin portal, `#/design-system` → style guide, `#/reset`/`#/invite` → link pages, else → the mobile app. */
export default function App() {
  return <><Routes /><PwaUpdate /></>;
}

function Routes() {
  const h = useHash();
  if (h.startsWith('#/admin')) return <Suspense fallback={null}><AdminApp /></Suspense>;
  if (h.startsWith('#/design-system')) return <Suspense fallback={null}><DesignSystem /></Suspense>;
  if (h.startsWith('#/reset')) return <Suspense fallback={null}><SetPasswordPage /></Suspense>;
  if (h.startsWith('#/invite')) return <Suspense fallback={null}><AcceptInvitePage /></Suspense>;
  if (h.startsWith('#/parent')) return <ParentEntry />;
  return <MobileApp />;
}

/** `#/parent` (or `#/parent/login`): the app opened on the parent sign-in. The hash is cleared so in-app back works. */
function ParentEntry() {
  useEffect(() => {
    parentLoginEntry();
    history.replaceState(history.state, '', location.pathname + location.search);
    // After the parent's hash listener is attached (child effects run first).
    setTimeout(() => window.dispatchEvent(new HashChangeEvent('hashchange')), 0);
  }, []);
  return null;
}

/**
 * On wide screens the app is shown inside a device frame next to the prototype panel
 * (mirrors the Claude Design prototype). On phones it renders full-screen.
 */
function MobileApp() {
  // The phone frame + prototype panel are a demo-mode desktop aid only: never when installed, never in live mode.
  const framed = useMedia(FRAME_QUERY) && !isStandalone() && !LIVE;
  const device = useApp((s) => s.device);

  useEffect(() => {
    const t = setInterval(tick, 250);
    startSplash();
    return () => clearInterval(t);
  }, []);

  if (!framed) {
    return <div dir="rtl" lang="ar" style={{ height: '100dvh' }}><AppShell framed={false} /></div>;
  }
  const dev = device === '360' ? { w: 380, h: 780 } : device === 'tablet' ? { w: 840, h: 1060 } : { w: 410, h: 864 };
  return (
    <div dir="rtl" lang="ar" style={{ minHeight: '100vh', display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'flex-start', gap: 28, padding: '28px 16px' }}>
      <DemoPanel />
      <div style={{ width: dev.w, maxWidth: '100%', flexShrink: 0, padding: 10, borderRadius: 46, background: '#14211F', boxShadow: '0 30px 60px -30px rgba(18,40,36,.5)' }}>
        <div style={{ height: dev.h, borderRadius: 36, overflow: 'hidden', position: 'relative' }}>
          <AppShell framed />
        </div>
      </div>
    </div>
  );
}
