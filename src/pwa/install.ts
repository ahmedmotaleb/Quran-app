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

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as BeforeInstallPromptEvent; emit(); });
  window.addEventListener('appinstalled', () => { deferred = null; emit(); });
}

/** 'prompt' = we can show the browser's install dialog; 'ios' = Share → Add to Home Screen steps; 'android' = the
 *  browser did not offer an install dialog (Samsung Internet, an in-app browser…): menu steps; null = installed or
 *  a desktop browser without install support. */
export type InstallHow = 'prompt' | 'ios' | 'android' | null;
export function useInstall(): InstallHow {
  return useSyncExternalStore(
    (f) => { subs.add(f); return () => subs.delete(f); },
    () => (isStandalone() ? null : deferred ? 'prompt' : isIos() ? 'ios' : isAndroid() ? 'android' : null),
  );
}

export const INSTALL_STEPS: Record<'ios' | 'android', { title: string; body: string }> = {
  ios: { title: 'ثبّت الحلقة على iPhone', body: 'افتح الرابط في Safari، ثم اضغط زر المشاركة (المربع والسهم) أسفل الشاشة، واختر «إضافة إلى الشاشة الرئيسية»، ثم «إضافة».' },
  android: { title: 'ثبّت الحلقة على جوالك', body: 'افتح الرابط في متصفح Chrome (إن فتحته من واتساب أو فيسبوك، اختر «الفتح في Chrome» أولًا)، ثم اضغط القائمة ⋮ أعلى الشاشة واختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».' },
};

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null; emit();
  return outcome === 'accepted';
}
