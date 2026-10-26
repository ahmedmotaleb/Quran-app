/* Web Push handlers, imported by the generated service worker (vite.config.ts → workbox.importScripts).
   The server sends only generic text (no names, scores, Quran ranges, notes or links to recordings) and, for a tap,
   only `/#/n/<id>`: the app opens that notification after checking the signed-in account. */
const SAFE_URL = (u) => (typeof u === 'string' && /^\/#\/(n\/\d+|inbox)$/.test(u) ? u : '/#/inbox');

self.addEventListener('push', (event) => {
  let d = { title: 'الحلقة', body: 'لديك إشعار جديد.', url: '/#/inbox', tag: 'halqa' };
  try { if (event.data) d = { ...d, ...event.data.json() }; } catch (e) { /* keep the generic text */ }
  event.waitUntil(self.registration.showNotification(d.title, {
    body: d.body, icon: '/icons/icon-192.png', badge: '/icons/favicon-48.png', dir: 'rtl', lang: 'ar',
    tag: d.tag, renotify: true, data: { url: SAFE_URL(d.url) },
  }));
});

/* A tap: focus an open HALQA window and take it to the notification, or open HALQA there. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = SAFE_URL(event.notification.data && event.notification.data.url);
  const url = new URL(path, self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find((c) => { const u = new URL(c.url); return u.origin === self.location.origin && !u.pathname.startsWith('/admin'); });
    if (!w) return self.clients.openWindow(url);
    try { await w.focus(); } catch (e) { /* not focusable: still navigate */ }
    try { if (w.navigate) { await w.navigate(url); return; } } catch (e) { /* uncontrolled window: ask it instead */ }
    w.postMessage({ type: 'halqa:navigate', url: path });
  })());
});
