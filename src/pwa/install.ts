/**
 * "Install app" support. Chrome/Edge/Android fire `beforeinstallprompt`; iOS Safari has no prompt,
 * so we show the Share → "Add to Home Screen" steps instead.
 */
import { useSyncExternalStore } from 'react';

interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

let deferred: BeforeInstallPromptEvent | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const isStandalone = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
export const isAndroid = () => /android/i.test(navigator.userAgent);

/** Set once the browser reports the app installed (appinstalled, or an accepted prompt): the browser tab never
 *  suggests installing again. The only state kept on the device besides the «لاحقًا» time. */
const INSTALLED_KEY = 'halqa.install.installed';
let installedHere = (() => { try { return localStorage.getItem(INSTALLED_KEY) === '1'; } catch { return false; } })();
function markInstalled() {
  installedHere = true; deferred = null;
  try { localStorage.setItem(INSTALLED_KEY, '1'); } catch { /* private mode */ }
  emit();
}
export const wasInstalled = () => installedHere;

if (typeof window !== 'undefined') {
  // Keep Chrome's event for our own «تثبيت التطبيق» button (the real browser dialog opens from it).
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as BeforeInstallPromptEvent; emit(); });
  window.addEventListener('appinstalled', markInstalled);
  window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', emit);
}

/** 'prompt' = we can show the browser's install dialog; 'ios' = Share → Add to Home Screen steps; 'android' = the
 *  browser did not offer an install dialog (Samsung Internet, an in-app browser…): menu steps; null = installed or
 *  a desktop browser without install support. */
export type InstallHow = 'prompt' | 'ios' | 'android' | null;
export function useInstall(): InstallHow {
  return useSyncExternalStore(
    (f) => { subs.add(f); return () => subs.delete(f); },
    () => (isStandalone() ? null : deferred ? 'prompt' : installedHere ? null : isIos() ? 'ios' : isAndroid() ? 'android' : null),
  );
}

export const INSTALL_STEPS: Record<'ios' | 'android', { title: string; body: string }> = {
  ios: { title: 'ثبّت الحلقة على iPhone', body: 'افتح الرابط في Safari، ثم اضغط زر المشاركة (المربع والسهم) أسفل الشاشة، واختر «إضافة إلى الشاشة الرئيسية»، ثم «إضافة».' },
  android: { title: 'ثبّت الحلقة على جوالك', body: 'افتح الرابط في متصفح Chrome (إن فتحته من واتساب أو فيسبوك، اختر «الفتح في Chrome» أولًا)، ثم اضغط القائمة ⋮ أعلى الشاشة واختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».' },
};

/** Opens the browser's real install dialog (only from a tap). The event can be used once; Chrome sends a new one
 *  later if the person cancelled. */
export async function promptInstall(): Promise<boolean> {
  const ev = deferred;
  if (!ev) return false;
  deferred = null;
  await ev.prompt();
  const { outcome } = await ev.userChoice;
  if (outcome === 'accepted') markInstalled(); else emit();
  return outcome === 'accepted';
}
export const hasInstallPrompt = () => !!deferred;
export const onInstallChange = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
