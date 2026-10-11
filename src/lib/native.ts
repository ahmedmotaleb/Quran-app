/**
 * Android (Capacitor) integration. Everything here is a no-op in the browser.
 * - Hardware back button follows in-app history instead of closing the app.
 * - System bar icon colour follows the screen (light icons on the dark live-session screen).
 */
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { back, closeSheet, openSheet, setState, useApp } from '@/store/store';

export const isNative = Capacitor.isNativePlatform();

function onBack() {
  const hash = window.location.hash;
  // Admin portal / design system: close an open admin dialog first, otherwise return to the app.
  if (hash.startsWith('#/admin') || hash.startsWith('#/design-system')) {
    import('@/admin/adminStore').then(({ useAdmin, closeDialog }) => {
      if (useAdmin.getState().dialog) closeDialog();
      else window.location.hash = '#/';
    });
    return;
  }
  const s = useApp.getState();
  if (s.sheet) { closeSheet(); return; }
  // Leaving an active live session needs the same confirmation as the on-screen leave button.
  if (s.screen === 'live' && (s.live.phase === 'live' || s.live.phase === 'reconnecting')) {
    openSheet({
      kind: 'confirm', title: 'الخروج من الجلسة؟', body: 'يمكنك العودة ما دامت الجلسة قائمة.', ok: 'اخرج من الجلسة', danger: true,
      onOk: () => setState((st) => ({ sheet: null, live: { ...st.live, phase: 'ended' } })),
    });
    return;
  }
  if (s.stack.length) { back(); return; }
  // At a root screen (tab, login, splash): behave like other Android apps and go to the background.
  App.minimizeApp();
}

export function initNative() {
  if (!isNative) return;
  App.addListener('backButton', onBack);
  let dark: boolean | null = null;
  const syncBars = (screen: string) => {
    const d = screen === 'live';
    if (d === dark) return;
    dark = d;
    SystemBars.setStyle({ style: d ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => {});
  };
  syncBars(useApp.getState().screen);
  useApp.subscribe((s) => syncBars(s.screen));
}
