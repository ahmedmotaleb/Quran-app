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

/* ---------- «حالة الإشعارات على هذا الجهاز» (حسابي ← الإشعارات) ---------- */
export interface PushDiag {
  supported: { sw: boolean; push: boolean; notification: boolean };
  permission: NotificationPermission | 'unsupported';
  standalone: boolean;
  sw: 'none' | 'installing' | 'active' | 'timeout';
  controlled: boolean;                       // this page is controlled by the service worker
  subscription: boolean;                     // this browser has a push subscription
  subscriptionHost: string | null;           // e.g. fcm.googleapis.com (no endpoint)
  keyMatches: boolean | null;                // the subscription was made with the server's current public key
  server: string;                            // ready / not_configured / misconfigured / unreachable
  publicKey: boolean;                        // the server handed out a public key
  registered: boolean | null;                // the server has THIS subscription for this account (and it is on)
  lastSuccessAt: string | null; lastFailure: string | null;
  devices: number;
  prefs: Record<string, boolean>;
  timezone: string | null;
  reminders: Record<string, { on: boolean; hour: number }> & { quiet?: [number, number] } | null;
  lastReminder: { kind: string; at: string } | null;
  promptLater: number | null; promptRefused: boolean;
}
type Status = { server: string; this_device: { active: boolean; last_success_at: string | null; last_failure: string } | null; devices: number;
  prefs: Record<string, boolean>; timezone: string; reminders: PushDiag['reminders']; last_reminder: PushDiag['lastReminder'] };

const ls = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };

/** Every link in the chain, as it really is on this device right now. Reads only; never asks for permission. */
export async function diagnosePush(): Promise<PushDiag> {
  const sup = { sw: typeof navigator !== 'undefined' && 'serviceWorker' in navigator, push: typeof window !== 'undefined' && 'PushManager' in window,
    notification: typeof window !== 'undefined' && 'Notification' in window };
  const d: PushDiag = { supported: sup, permission: sup.notification ? Notification.permission : 'unsupported', standalone: standalone(),
    sw: 'none', controlled: false, subscription: false, subscriptionHost: null, keyMatches: null, server: 'unreachable', publicKey: false,
    registered: null, lastSuccessAt: null, lastFailure: null, devices: 0, prefs: {}, timezone: null, reminders: null, lastReminder: null,
    promptLater: Number(ls('halqa.reminderPrompt.later')) || null, promptRefused: !!ls('halqa.reminderPrompt.denied') };
  let cfg: Cfg | null = null;
  try { cfg = await config(); d.publicKey = !!cfg.public_key; } catch { /* unreachable */ }
  let sub: PushSubscription | null = null;
  if (sup.sw) {
    d.controlled = !!navigator.serviceWorker.controller;
    const r = await navigator.serviceWorker.getRegistration('/').catch(() => undefined);
    if (r) {
      d.sw = r.active ? 'active' : r.installing || r.waiting ? 'installing' : 'none';
      if (sup.push && r.active) {
        sub = await r.pushManager.getSubscription().catch(() => null);
        d.subscription = !!sub;
        if (sub) {
          try { d.subscriptionHost = new URL(sub.endpoint).host; } catch { /* keep null */ }
          d.keyMatches = cfg?.public_key ? b64url(sub.options?.applicationServerKey) === cfg.public_key : null;
        }
      }
    }
  }
  try {
    const st = await api<Status>('GET', sub ? `push/status?endpoint=${encodeURIComponent(sub.endpoint)}` : 'push/status');
    d.server = st.server; d.devices = st.devices; d.prefs = st.prefs; d.timezone = st.timezone; d.reminders = st.reminders; d.lastReminder = st.last_reminder;
    d.registered = sub ? !!st.this_device?.active : null;
    d.lastSuccessAt = st.this_device?.last_success_at ?? null; d.lastFailure = st.this_device?.last_failure || null;
  } catch { /* shown as unreachable */ }
  return d;
}

/** «ربط الجهاز بالإشعارات»: the service worker, a subscription with the server's CURRENT key, saved on the server, and
 *  then read back from the server. Success only when the server confirms this exact device. */
export async function connectDevice(): Promise<void> {
  if (!supported()) throw new PushError(isIos() && !standalone() ? 'على iPhone ثبّت الحلقة على الشاشة الرئيسية أولًا.' : 'هذا المتصفح لا يدعم إشعارات الويب.');
  const cfg = await config().catch(() => { throw new PushError('تعذّر الوصول إلى الخادم. تحقق من الاتصال.'); });
  if (!cfg.enabled || !cfg.public_key) throw new PushError('إشعارات الجوال غير جاهزة على الخادم.');
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();   // only from the button
  if (perm !== 'granted') throw new PushError('إذن الإشعارات غير ممنوح لهذا الموقع. فعّله من إعدادات الهاتف ← التطبيقات ← الحلقة أو Chrome ← الإشعارات.');
  let reg = await navigator.serviceWorker.getRegistration('/').catch(() => undefined) ?? null;
  // The admin portal (/admin/) does not register the app's service worker itself: register it here (same file, scope /)
  // so administrators can receive pushes even if they never opened the learners' app on this device.
  if (!reg) reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => null);
  if (!reg?.active) reg = await Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 15000))]);
  if (!reg) throw new PushError('لم يكتمل تثبيت خدمة التطبيق (Service Worker). أغلق الحلقة وافتحها من جديد ثم حاول مرة أخرى.');
  let sub: PushSubscription;
  try { sub = await subscription(reg, cfg.public_key); }
  catch (e) {
    const n = (e as { name?: string })?.name;
    throw new PushError(n === 'NotAllowedError' ? 'رفض المتصفح الاشتراك: إذن الإشعارات غير ممنوح.'
      : n === 'AbortError' ? 'تعذّر الاتصال بخدمة الإشعارات (Google). تأكد من الإنترنت ومن تحديث Chrome وخدمات Google Play.'
      : 'تعذّر الاشتراك في خدمة الإشعارات على هذا الهاتف.');
  }
  try { await api('POST', 'push/subscriptions', sub.toJSON()); }
  catch (e) { throw new PushError(e instanceof ApiError ? e.message : 'تعذّر حفظ الجهاز على الخادم.'); }
  const back = await config(sub.endpoint).catch(() => null);
  if (!back?.this_device) throw new PushError('لم يؤكد الخادم تسجيل هذا الجهاز. حاول مرة أخرى.');
  try { localStorage.removeItem('halqa.reminderPrompt.denied'); } catch { /* private mode */ }
}

/** «إرسال إشعار تجريبي» to this account's devices, this device first. */
export async function selfTest(): Promise<{ sent: number; this_device: boolean; this_device_sent: boolean; message: string }> {
  let endpoint = '';
  try { endpoint = (await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription())?.endpoint ?? ''; } catch { /* none */ }
  return api('POST', 'push/test', { endpoint });
}
