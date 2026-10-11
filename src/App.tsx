import { useEffect, useState } from 'react';
import AppShell from './AppShell';
import DemoPanel from './demo/DemoPanel';
import { startSplash, tick, useApp } from './store/store';

const FRAME_QUERY = '(min-width: 760px)';

function useMedia(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q); const on = () => setM(mq.matches);
    mq.addEventListener('change', on); return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

/**
 * On wide screens the app is shown inside a device frame next to the prototype panel
 * (mirrors the Claude Design prototype). On phones it renders full-screen.
 */
export default function App() {
  const framed = useMedia(FRAME_QUERY);
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
