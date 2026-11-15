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

/** Which browser this is (Android). Only Google Chrome installs a PWA as a WebAPK minted and signed by Google;
 *  other Chromium browsers (Edge, Opera, Brave, Yandex, Mi, Huawei…) build their own install package, which Play
 *  Protect can flag («built for an older version of Android»): owner report 14 Nov 2026. */
export type BrowserFamily = 'chrome' | 'samsung' | 'edge' | 'opera' | 'brave' | 'yandex' | 'vivaldi' | 'mi' | 'huawei' | 'firefox'
  | 'duckduckgo' | 'webview' | 'inapp' | 'safari' | 'other';
export function browserFamily(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): BrowserFamily {
  if (/FBAN|FBAV|Instagram|Line\/|Snapchat|TikTok|musical_ly/i.test(ua)) return 'inapp';
  if (/; wv\)/.test(ua)) return 'webview';
  if (/SamsungBrowser/i.test(ua)) return 'samsung';
  if (/EdgA\//.test(ua) || /Edg\//.test(ua)) return 'edge';
  if (/OPR\/|OPT\/|Opera/.test(ua)) return 'opera';
  if (/YaBrowser|YaSearchBrowser/.test(ua)) return 'yandex';
  if (/Vivaldi/.test(ua)) return 'vivaldi';
  if (/MiuiBrowser|XiaoMi/i.test(ua)) return 'mi';
  if (/HuaweiBrowser|HONORBrowser/i.test(ua)) return 'huawei';
  if (/DuckDuckGo/i.test(ua)) return 'duckduckgo';
  if (/Firefox|FxiOS/.test(ua)) return 'firefox';
  if (typeof navigator !== 'undefined' && 'brave' in navigator) return 'brave';
  if (/CriOS/.test(ua)) return 'safari';                 // Chrome on iOS installs through Safari's Add to Home Screen
  if (/Chrome\/\d/.test(ua)) return 'chrome';
  if (/Safari/.test(ua)) return 'safari';
  return 'other';
}
/** Android, but not Google Chrome: recommend installing from Chrome (see browserFamily). */
export const androidNotChrome = () => isAndroid() && browserFamily() !== 'chrome';
/** Opens this same page in Google Chrome on Android (a standard intent link; nothing is downloaded). */
export function chromeIntentUrl(href = typeof location !== 'undefined' ? location.href : ''): string {
  const u = new URL(href);
  return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(u.href)};end`;
}

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

/** Chrome offers installation only when HALQA is NOT installed: a stale «installed» mark (the app was removed since)
 *  must not hide the offer for good. */
function offered(e: BeforeInstallPromptEvent) {
  deferred = e;
  if (installedHere) { installedHere = false; try { localStorage.removeItem(INSTALLED_KEY); } catch { /* private mode */ } }
  emit();
}
if (typeof window !== 'undefined') {
  // Keep Chrome's event for our own «تثبيت التطبيق» button (the real browser dialog opens from it). It may have
  // fired before this code loaded: public/install-gate.js keeps it in window.__halqaInstallEvent.
  const early = (window as Window & { __halqaInstallEvent?: BeforeInstallPromptEvent }).__halqaInstallEvent;
  if (early) offered(early);
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); offered(e as BeforeInstallPromptEvent); });
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
    () => (isStandalone() ? null : installedHere ? null : androidNotChrome() ? 'android'   // install from Chrome (WebAPK by Google)
      : deferred ? 'prompt' : isIos() ? 'ios' : isAndroid() ? 'android' : null),
  );
}

export const INSTALL_STEPS: Record<'ios' | 'android', { title: string; body: string }> = {
  ios: { title: 'ثبّت الحلقة على iPhone', body: 'افتح الرابط في Safari، ثم اضغط زر المشاركة (المربع والسهم) أسفل الشاشة، واختر «إضافة إلى الشاشة الرئيسية»، ثم «إضافة».' },
  android: { title: 'ثبّت الحلقة على جوالك', body: 'ثبّت الحلقة من متصفح Google Chrome: اضغط «فتح في Chrome»، ثم «تثبيت التطبيق». التثبيت من متصفحات أخرى قد يُظهر تحذير Google Play Protect لأن تلك المتصفحات تُنشئ التطبيق بإعدادات Android قديمة. إن لم يظهر زر التثبيت في Chrome: القائمة ⋮ ← «تثبيت التطبيق».' },
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
  noteInstall(outcome);
  return outcome === 'accepted';
}
/** Install attempts reach the server's client diagnostics with the browser family only (Ops → client-diagnostics):
 *  which browser produced a Play Protect warning is then known, not guessed. Never blocks anything. */
export function noteInstall(step: string) {
  void import('@/services/diag').then((m) => m.diag('install', { step: `${browserFamily()}:${step}` })).catch(() => {});
}
export const hasInstallPrompt = () => !!deferred;
export const onInstallChange = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
