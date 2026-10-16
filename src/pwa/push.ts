/** Web Push opt-in for this device (pack prompt 18). Permission is asked only when the user taps the button. */
import { api } from '@/api/client';

export type PushState = 'unsupported' | 'ios-install' | 'server-off' | 'denied' | 'off' | 'on';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

function keyBytes(b64: string) {
  const s = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function currentSub() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return isIos() && !standalone() ? 'ios-install' : 'unsupported';
  const cfg = await api<{ enabled: boolean }>('GET', 'push/config');
  if (!cfg.enabled) return 'server-off';
  if (Notification.permission === 'denied') return 'denied';
  const sub = await currentSub();
  if (!sub) return 'off';
  const mine = await api<{ this_device: boolean }>('GET', `push/config?endpoint=${encodeURIComponent(sub.endpoint)}`);
  return mine.this_device ? 'on' : 'off';
}

export async function enablePush(): Promise<PushState> {
  const cfg = await api<{ enabled: boolean; public_key: string | null }>('GET', 'push/config');
  if (!cfg.enabled || !cfg.public_key) return 'server-off';
  if ((await Notification.requestPermission()) !== 'granted') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(cfg.public_key) });
  await api('POST', 'push/subscriptions', sub.toJSON());
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const sub = await currentSub();
  if (sub) {
    await api('DELETE', 'push/subscriptions', { endpoint: sub.endpoint });
    await sub.unsubscribe().catch(() => {});
  }
  return 'off';
}
