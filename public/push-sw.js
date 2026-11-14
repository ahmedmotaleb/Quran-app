/* Web Push handlers, imported by the generated service worker (vite.config.ts → workbox.importScripts).
   The server sends only generic text (no names, scores, Quran ranges, notes or links to recordings) and, for a tap,
   only `/#/n/<id>`: the app opens that notification after checking the signed-in account. */
// The learners' app opens a notification by id; administrators' notices open an admin portal section (the portal
// checks the admin session and permission again). Anything else falls back to the inbox.
const SAFE_URL = (u) => (typeof u === 'string' && (/^\/#\/(n\/\d+|inbox)$/.test(u) || /^\/admin\/#\/admin\/[A-Za-z]+$/.test(u)) ? u : '/#/inbox');

/* Delivery receipt: tells the server that this push ARRIVED on the phone and whether the notification was displayed,
   using the signed token from the payload (no account data). «إرسال إشعار تجريبي» reads it back. */
const receipt = (r, body) => (typeof r === 'string' && r
  ? fetch('/api/v1/push/receipt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ r, ...body }), keepalive: true }).catch(() => {})
  : Promise.resolve());

self.addEventListener('push', (event) => {
  let d = { title: 'الحلقة', body: 'لديك إشعار جديد.', url: '/#/inbox', tag: 'halqa' };
  try { if (event.data) d = { ...d, ...event.data.json() }; } catch (e) { /* keep the generic text */ }
  // Shown even when HALQA is open, in the background, closed or the phone is locked (userVisibleOnly). Whether it
  // pops up (heads-up), rings or vibrates is up to Android: the site's notification settings and battery saving.
  event.waitUntil((async () => {
    try {
      await self.registration.showNotification(d.title || 'الحلقة', {
        body: d.body, icon: '/icons/icon-192.png', badge: '/icons/favicon-48.png', dir: 'rtl', lang: 'ar',
        tag: d.tag, renotify: true, vibrate: [200, 100, 200], timestamp: Date.now(), data: { url: SAFE_URL(d.url) },
      });
      let shown = true;
      try { shown = (await self.registration.getNotifications({ tag: d.tag })).length > 0; } catch (e) { /* not supported: assume shown */ }
      await receipt(d.r, { ok: true, shown });
      // Open HALQA windows refresh right away (unread count; a teacher change reloads the student/teacher screens).
      try { (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).forEach((c) => c.postMessage({ type: 'halqa:push' })); } catch (e) { /* none open */ }
    } catch (e) {
      // Android refused to display it (notifications blocked for the app, for example): tell the server why.
      await receipt(d.r, { ok: false, error: String((e && e.name) || e).slice(0, 40) });
      throw e;
    }
  })());
});

/* The browser replaced this device's push subscription by itself (keys expired, push service change): subscribe again
   with the same server key and move the server's record to the new one, proving it with the old keys — no session
   needed, so it also works while the app is closed. If anything is missing, the app repairs it at its next start. */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const old = event.oldSubscription;
    let fresh = event.newSubscription;
    try {
      if (!fresh && old && old.options && old.options.applicationServerKey) {
        fresh = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: old.options.applicationServerKey });
      }
      if (!old || !fresh) return;
      await fetch('/api/v1/push/rotate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old: old.toJSON(), new: fresh.toJSON() }), keepalive: true });
    } catch (e) { /* the app re-registers on its next start */ }
  })());
});

/* A tap: focus an open HALQA window and take it to the notification, or open HALQA there. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = SAFE_URL(event.notification.data && event.notification.data.url);
  const url = new URL(path, self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const admin = path.startsWith('/admin/');
    // The same kind of window: the admin portal for admin notices, the learners' app otherwise.
    const w = wins.find((c) => { const u = new URL(c.url); return u.origin === self.location.origin && u.pathname.startsWith('/admin') === admin; });
    if (!w) return self.clients.openWindow(url);
    try { await w.focus(); } catch (e) { /* not focusable: still navigate */ }
    try { if (w.navigate) { await w.navigate(url); return; } } catch (e) { /* uncontrolled window: ask it instead */ }
    w.postMessage({ type: 'halqa:navigate', url: path });
  })());
});
