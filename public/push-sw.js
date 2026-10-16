/* Web Push handlers, imported by the generated service worker (vite.config.ts → workbox.importScripts).
   The server sends only generic text (no names, scores or Quran ranges); the app shows details after sign-in. */
self.addEventListener('push', (event) => {
  let d = { title: 'الحلقة', body: 'لديك إشعار جديد.', url: '/#/inbox', tag: 'halqa' };
  try { if (event.data) d = { ...d, ...event.data.json() }; } catch (e) { /* keep the generic text */ }
  event.waitUntil(self.registration.showNotification(d.title, {
    body: d.body, icon: '/icons/icon-192.png', badge: '/icons/favicon-48.png', dir: 'rtl', lang: 'ar', tag: d.tag, data: { url: d.url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const w = wins.find((c) => c.url.startsWith(self.location.origin));
    if (w) return w.focus().then(() => w.navigate(url)).catch(() => self.clients.openWindow(url));
    return self.clients.openWindow(url);
  }));
});
