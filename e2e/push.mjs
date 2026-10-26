// Web Push (pack prompt 18) on the live preview build: the Account screen explains the state honestly (here the
// server has no VAPID keys, so push is "not enabled on the server" and nothing is asked); and the service worker's
// push handler shows a generic RTL notification that opens the app, checked by injecting a push message through
// Chrome DevTools (a real push service is not reachable from CI browsers).
// A tapped notification opens `#/n/<id>` (or `#/inbox`): the app opens it for the signed-in account only.
//   node e2e/push.mjs <shots> [liveUrl=http://localhost:4175/]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const out = process.argv[2]; const LIVE = (process.argv[3] || 'http://localhost:4175/').replace(/\/?$/, '/');
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'halqa-push-')), {
  // Full Chromium in new-headless mode: Playwright's default headless shell cannot show notifications.
  executablePath: process.env.CHROMIUM_PATH || undefined, channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
  viewport: { width: 390, height: 844 },
});
await ctx.grantPermissions(['notifications'], { origin: new URL(LIVE).origin });
const page = ctx.pages()[0] ?? await ctx.newPage(); page.setDefaultTimeout(15000);
const app = page.locator('main#scr');
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${out}/push-fail-${name.replace(/\W+/g, '_')}.png` }); } };
let prompted = false;
page.on('dialog', () => { prompted = true; });

await page.goto(LIVE);
await step('the generated service worker loads the push handlers', async () => {
  await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true));
  const sw = await (await page.request.get(LIVE + 'sw.js')).text();
  if (!sw.includes('push-sw.js')) throw new Error('sw.js does not import push-sw.js');
  if (!(await page.request.get(LIVE + 'push-sw.js')).ok()) throw new Error('push-sw.js not served');
});
await step('Account explains push honestly; nothing is requested on its own', async () => {
  await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.locator('#lg-email').fill('yousef@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText('السلام عليكم، يوسف').waitFor();
  await page.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  const ready = await (await page.request.get(LIVE + 'api/ready')).json();
  if (ready.features.push === 'ready') {
    // permission already granted in this browser, no subscription yet: the device is not subscribed; one button
    await app.getByText('هذا الجهاز غير مشترك في الإشعارات').waitFor();
    await app.getByRole('button', { name: 'تفعيل الإشعارات', exact: true }).waitFor();
  } else {
    await app.getByText('الإشعارات غير مفعلة', { exact: true }).waitFor();
    await app.getByText('إشعارات الجوال غير متاحة على الخادم حاليًا.', { exact: false }).waitFor();
    if (await app.getByRole('button', { name: 'تفعيل الإشعارات', exact: true }).count()) throw new Error('enable offered while the server is not ready');
  }
  if (prompted) throw new Error('a prompt appeared without a tap');
});
await page.screenshot({ path: out + '/push-account.png' });
await step('the «الإشعارات» switches are saved on the server (push follows them)', async () => {
  const sw = app.getByRole('switch', { name: 'تذكير بالواجبات' });
  const before = await sw.getAttribute('aria-checked');
  await sw.click();
  await page.waitForTimeout(800);
  await page.reload(); await app.getByText('السلام عليكم، يوسف').waitFor();
  await page.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  if (await app.getByRole('switch', { name: 'تذكير بالواجبات' }).getAttribute('aria-checked') === before) throw new Error('not persisted');
  await app.getByRole('switch', { name: 'تذكير بالواجبات' }).click(); await page.waitForTimeout(500); // restore
});
await step('a push message shows a generic RTL notification that opens the app', async () => {
  await page.reload(); await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  const reg = await new Promise((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => { const r = registrations.find((x) => !x.isDeleted); if (r) resolve(r); });
  });
  const payload = { title: 'الحلقة', body: 'وصل تقييم جديد من معلمك.', url: '/#/n/7', tag: 'feedback' };
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: new URL(LIVE).origin, registrationId: reg.registrationId, data: JSON.stringify(payload) });
  let shown = null;
  for (let i = 0; i < 40 && !shown; i++) {   // the handler runs asynchronously in the worker: poll for its notification
    shown = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.ready; const n = await r.getNotifications();
      return n.length ? { title: n[0].title, body: n[0].body, dir: n[0].dir, url: n[0].data && n[0].data.url } : null;
    });
    if (!shown) await page.waitForTimeout(250);
  }
  if (!shown) throw new Error('no notification was shown within 10 s');
  if (shown.title !== 'الحلقة' || shown.body !== payload.body || shown.dir !== 'rtl' || shown.url !== '/#/n/7') throw new Error(JSON.stringify(shown));
});
await step('a push asking for an outside or unknown link is reduced to the inbox', async () => {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  const reg = await new Promise((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => { const r = registrations.find((x) => !x.isDeleted); if (r) resolve(r); });
  });
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: new URL(LIVE).origin, registrationId: reg.registrationId,
    data: JSON.stringify({ title: 'الحلقة', body: 'x', url: 'https://evil.example/#/n/1', tag: 'evil' }) });
  let url = null;
  for (let i = 0; i < 40 && !url; i++) {
    url = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; const n = (await r.getNotifications({ tag: 'evil' }))[0]; return n ? n.data.url : null; });
    if (!url) await page.waitForTimeout(250);
  }
  if (url !== '/#/inbox') throw new Error(`unsafe url kept: ${url}`);
});
await step('opening HALQA from a notification link lands on the right screen', async () => {
  await page.goto(LIVE + '#/inbox'); await app.getByRole('heading', { name: 'الإشعارات', exact: true }).waitFor();
  await page.goto(LIVE + '#/n/999999');   // not this account's notification: the inbox, nothing else
  await app.getByRole('heading', { name: 'الإشعارات', exact: true }).waitFor();
  if (page.url().includes('#/n/')) throw new Error('the hash was not cleared');
});
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await ctx.close();
