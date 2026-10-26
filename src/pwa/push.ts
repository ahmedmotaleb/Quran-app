/** Web Push for THIS device (pack prompt 18; production fix 26 Oct 2026). Permission is asked only when the user taps
 *  «تفعيل الإشعارات». The state shown is the real one: the browser permission + this browser's push subscription +
 *  the server's record for that exact subscription (`push/config?endpoint=`), not only a saved preference.
 *  A subscription made with older server keys (rotated) or one the server switched off is replaced silently when
 *  permission is already granted — never a new prompt. */
import { api, ApiError } from '@/api/client';

export type PushState = 'unsupported' | 'ios-install' | 'server-off' | 'denied' | 'off' | 'on';
type Cfg = { enabled: boolean; public_key: string | null; this_device?: boolean; devices?: number };

const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

function keyBytes(b64: string) {
  const s = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
const b64url = (buf: ArrayBuffer | null | undefined) => buf
  ? btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '';

/** The service worker, or null if none is active within a few seconds (a page opened before it was installed). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 6000))]);
}

async function config(endpoint?: string) {
  return api<Cfg>('GET', endpoint ? `push/config?endpoint=${encodeURIComponent(endpoint)}` : 'push/config');
}

/** A subscription signed for the server's CURRENT key (re-made if it was created for another key). */
async function subscription(reg: ServiceWorkerRegistration, publicKey: string): Promise<PushSubscription> {
  let sub = await reg.pushManager.getSubscription();
  if (sub && b64url(sub.options?.applicationServerKey) && b64url(sub.options.applicationServerKey) !== publicKey) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  return sub ?? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return isIos() && !standalone() ? 'ios-install' : 'unsupported';
  const cfg = await config();
  if (!cfg.enabled || !cfg.public_key) return 'server-off';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await registration();
  if (!reg) return 'unsupported';
  const sub = await reg.pushManager.getSubscription();
  if (!sub || Notification.permission !== 'granted') return 'off';
  if ((await config(sub.endpoint)).this_device && b64url(sub.options?.applicationServerKey) === cfg.public_key) return 'on';
  // Granted, but the server does not have this device (or switched it off, or the keys changed): register it again.
  try { await register(reg, cfg.public_key); return 'on'; } catch { return 'off'; }
}

async function register(reg: ServiceWorkerRegistration, publicKey: string) {
  const sub = await subscription(reg, publicKey);
  await api('POST', 'push/subscriptions', sub.toJSON());
}

/** Arabic reason when enabling fails (shown under the button instead of a generic error). */
export class PushError extends Error {}

export async function enablePush(): Promise<PushState> {
  if (!supported()) {
    if (isIos() && !standalone()) return 'ios-install';
    throw new PushError('هذا المتصفح لا يدعم إشعارات الويب. استخدم Chrome أو Edge، أو ثبّت التطبيق.');
  }
  const cfg = await config();
  if (!cfg.enabled || !cfg.public_key) return 'server-off';
  const perm = await Notification.requestPermission();   // only ever called from the button
  if (perm === 'denied') return 'denied';
  if (perm !== 'granted') throw new PushError('لم يُمنح الإذن. اضغط «تفعيل الإشعارات» مرة أخرى واختر «السماح».');
  const reg = await registration();
  if (!reg) throw new PushError('لم يكتمل تحميل التطبيق بعد. أعد فتح الحلقة ثم حاول مرة أخرى.');
  try {
    await register(reg, cfg.public_key);
  } catch (e) {
    if (e instanceof ApiError) throw new PushError(e.message);
    throw new PushError('تعذّر الاشتراك في خدمة الإشعارات على هذا المتصفح. تأكد من الاتصال بالإنترنت، وعلى Android من تحديث Chrome وخدمات Google Play.');
  }
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const reg = await registration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await api('DELETE', 'push/subscriptions', { endpoint: sub.endpoint });   // only this device
    await sub.unsubscribe().catch(() => {});
  }
  return 'off';
}

/** On app start/sign-in: if this device already allowed notifications, make sure the server has it for the signed-in
 *  account (a new sign-in, a server-side clean-up, rotated keys). Never asks for permission. */
export async function syncPush(): Promise<void> {
  try {
    if (supported() && Notification.permission === 'granted') await pushState();
  } catch { /* the account screen shows the state */ }
}

/** This device's endpoint, so signing out removes only this device's subscription. */
export async function currentEndpoint(): Promise<string> {
  try {
    if (!supported()) return '';
    const reg = await registration();
    return (await reg?.pushManager.getSubscription())?.endpoint ?? '';
  } catch { return ''; }
}
