// PWA checks: manifest + icons, Chrome installability, service worker, offline launch, no API/private data
// in caches, phone back button walks in-app history. Run against `vite preview` builds.
//   node e2e/pwa.mjs <shots> [demoUrl=http://localhost:4173/] [liveUrl=http://localhost:4175/]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const DEMO = process.argv[3] || 'http://localhost:4173/'; const LIVE = process.argv[4] || 'http://localhost:4175/';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Persistent (non-incognito) profiles: Chrome never reports installability in incognito.
const open = () => chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'halqa-pwa-')), { executablePath: process.env.CHROMIUM_PATH || undefined, viewport: { width: 390, height: 844 } });
let fails = 0;
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await p?.screenshot({ path: `${out}/fail-${name.replace(/\W+/g, '_')}.png` }); } };
const ctx = await open();
const page = ctx.pages()[0] ?? await ctx.newPage(); page.setDefaultTimeout(10000);
const app = page.locator('main#scr');
await page.goto(DEMO);

await step(page, 'manifest is linked and complete', async () => {
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const m = await (await page.request.get(new URL(href, DEMO).href)).json();
  for (const k of ['name', 'short_name', 'start_url', 'display', 'icons', 'theme_color', 'background_color']) if (!m[k]) throw new Error('missing ' + k);
  if (m.dir !== 'rtl' || m.lang !== 'ar' || m.display !== 'standalone') throw new Error('rtl/ar/standalone');
  if (!m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable')) throw new Error('no maskable icon');
  for (const i of m.icons) { const r = await page.request.get(new URL(i.src, DEMO).href); if (!r.ok() || !r.headers()['content-type'].includes('png')) throw new Error('icon ' + i.src); }
});
await step(page, 'service worker installs and controls the page', async () => {
  await page.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker.ready.then(() => true), null, { timeout: 15000 });
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
});
await step(page, 'Chrome reports the app installable', async () => {
  const cdp = await ctx.newCDPSession(page);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  if (installabilityErrors.length) throw new Error(JSON.stringify(installabilityErrors));
});
await step(page, 'launches offline (app shell from cache)', async () => {
  await ctx.setOffline(true);
  await page.reload();
  await app.getByRole('button', { exact: true, name: 'تخطَّ' }).waitFor();
  await page.screenshot({ path: out + '/pwa-offline.png' });
  await ctx.setOffline(false);
});
await step(page, 'phone back button walks in-app screens, not out of the app', async () => {
  await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.getByRole('button', { exact: true, name: 'طالب' }).click();
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText('السلام عليكم، يوسف').waitFor();
  await page.getByRole('navigation').getByRole('button', { exact: true, name: 'تعلمي' }).click();
  await app.getByText('حفظ سورة الملك').click();
  await app.getByRole('heading', { name: 'تفاصيل المهمة' }).waitFor();
  await app.getByRole('button', { name: /افتح النطاق في المصحف/ }).click();
  await page.goBack();                     // hardware back
  await app.getByRole('heading', { name: 'تفاصيل المهمة' }).waitFor();
  await page.goBack();
  await app.getByRole('tab', { name: /حفظ/ }).waitFor();
  if (!page.url().startsWith(DEMO)) throw new Error('left the app: ' + page.url());
});
await step(page, 'on-screen back keeps history in step', async () => {
  await app.getByText('حفظ سورة الملك').click();
  await app.getByRole('button', { name: /رجوع/ }).first().click();
  await app.getByRole('tab', { name: /حفظ/ }).waitFor();
  await page.goBack();                     // should not re-open the task
  await page.waitForTimeout(300);
  if (await app.getByRole('heading', { name: 'تفاصيل المهمة' }).count()) throw new Error('history out of step');
});

// Live build: API responses must never be cached by the service worker.
const lctx = await open();
const lp = lctx.pages()[0] ?? await lctx.newPage(); lp.setDefaultTimeout(10000);
const la = lp.locator('main#scr');
await lp.goto(LIVE);
await step(lp, 'live: sign in through the service worker; no API data in caches', async () => {
  await lp.waitForFunction(() => navigator.serviceWorker.ready.then(() => true), null, { timeout: 15000 });
  await lp.reload(); await lp.waitForFunction(() => !!navigator.serviceWorker.controller);
  await la.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await la.locator('#lg-email').fill('yousef@halqa.app'); await la.locator('#lg-pw').fill('halqa123');
  await la.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await la.getByText('السلام عليكم، يوسف').waitFor();
  const urls = await lp.evaluate(async () => {
    const all = [];
    for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) all.push(r.url);
    return all;
  });
  const bad = urls.filter((u) => u.includes('/api/') || u.includes('/media/'));
  if (bad.length) throw new Error('cached: ' + bad.join(', '));
  if (!urls.some((u) => u.includes('/index.html'))) throw new Error('shell not precached');
});
await step(lp, 'live: offline shows the shell, not stale learner data', async () => {
  await lctx.setOffline(true);
  await lp.reload();
  await la.getByRole('button', { exact: true, name: 'تخطَّ' }).waitFor();   // session cannot be restored offline
  if (await la.getByText('حفظ سورة الملك').count()) throw new Error('learner data shown offline');
  await lctx.setOffline(false);
});
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await ctx.close(); await lctx.close();
