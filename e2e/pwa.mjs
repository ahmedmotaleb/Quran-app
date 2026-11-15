// PWA checks: manifest + icons, Chrome installability, service worker, offline launch, no API/private data
// in caches, phone back button walks in-app history. Run against `vite preview` builds.
//   node e2e/pwa.mjs <shots> [demoUrl=http://localhost:4173/] [liveUrl=http://localhost:4175/]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { pickWho } from './lib/who.mjs';
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
await step(page, 'the manifest (installability) only in browsers whose Android install is safe: Chrome, iPhone, desktop', async () => {
  // Owner report 15 Nov 2026: Samsung Internet built an app package that Play Protect blocked. Other Android browsers
  // get no manifest, so they offer no install of their own; «تثبيت التطبيق» sends them to Chrome (install.mjs).
  const UAS = {
    chromeAndroid: ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', true],
    iphone: ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', true],
    desktop: ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', true],
    samsung: ['Mozilla/5.0 (Linux; Android 10; SM-A505F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36', false],
    edge: ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0', false],
    opera: ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 OPR/85.0.0.0', false],
    webview: ['Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36', false],
  };
  const b2 = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  for (const [name, [ua, want]] of Object.entries(UAS)) {
    for (const [path, href] of [['', '/manifest.webmanifest'], ['admin/', '/admin/manifest.webmanifest']]) {
      const c = await b2.newContext({ userAgent: ua, serviceWorkers: 'block' });
      const p = await c.newPage();
      await p.goto(new URL(path, DEMO).href);
      const links = await p.locator('link[rel="manifest"]').evaluateAll((l) => l.map((x) => x.getAttribute('href')));
      const ok = want ? links.length === 1 && links[0] === href : links.length === 0;
      await c.close();
      if (!ok) { await b2.close(); throw new Error(`${name} /${path}: manifest links ${JSON.stringify(links)}`); }
    }
  }
  await b2.close();
});
await step(page, 'Chrome on Android offers installation before the app loads: the offer is kept, «تثبيت التطبيق» shows', async () => {
  // Owner report 15 Nov 2026: no install message. Chrome fires `beforeinstallprompt` once; public/install-gate.js keeps
  // it for src/pwa/install.ts. Dispatched at readyState «interactive», before the module scripts run.
  const b2 = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const c = await b2.newContext({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', isMobile: true, hasTouch: true, viewport: { width: 390, height: 800 }, serviceWorkers: 'block' });
  await c.addInitScript(() => document.addEventListener('readystatechange', () => {
    if (document.readyState !== 'interactive') return;
    window.__appLoadedAtOffer = !!document.querySelector('main#scr');
    const e = new Event('beforeinstallprompt', { cancelable: true });
    e.prompt = async () => { window.__prompted = (window.__prompted || 0) + 1; };
    e.userChoice = Promise.resolve({ outcome: 'dismissed', platform: 'web' });
    window.dispatchEvent(e);
  }));
  const p = await c.newPage(); p.setDefaultTimeout(10000);
  try {
    await p.goto(DEMO);
    await p.locator('main#scr').getByRole('button', { exact: true, name: 'تخطَّ' }).click();
    if (await p.evaluate(() => window.__appLoadedAtOffer)) throw new Error('the offer came after the app loaded (not early)');
    await p.getByTestId('install-sheet').getByRole('button', { name: 'تثبيت التطبيق' }).click();
    await p.waitForFunction(() => window.__prompted === 1);
  } finally { await b2.close(); }
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
  await app.getByRole('button', { exact: true, name: 'طالب' }).click();          // demo account chip (also picks «طالب»)
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
  await pickWho(la, 'yousef@halqa.app'); await la.locator('#lg-email').fill('yousef@halqa.app'); await la.locator('#lg-pw').fill('halqa123');
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
  // The admin portal always loads the current release from the network (a cached admin page once ran a version
  // without «تذكّر هذا الجهاز», 23 Oct).
  const adminCached = urls.filter((u) => /\/admin\//.test(u));
  if (adminCached.length) throw new Error('admin page cached: ' + adminCached.join(', '));
});
await step(lp, 'live: offline shows the shell, not stale learner data', async () => {
  await lctx.setOffline(true);
  await lp.reload();
  await la.getByRole('button', { exact: true, name: 'تخطَّ' }).waitFor();   // session cannot be restored offline
  if (await la.getByText('حفظ سورة الملك').count()) throw new Error('learner data shown offline');
  await lctx.setOffline(false);
});
// The admin portal is a separate installable app: its own page at /admin/, manifest id and scope /admin/.
const actx = await open();
const ap = actx.pages()[0] ?? await actx.newPage(); ap.setDefaultTimeout(10000);
await step(ap, 'admin portal installs as its own app («إدارة الحلقة», scope /admin/)', async () => {
  await ap.goto(DEMO + 'admin/');
  const links = await ap.locator('link[rel="manifest"]').evaluateAll((l) => l.map((x) => x.getAttribute('href')));
  if (links.length !== 1 || links[0] !== '/admin/manifest.webmanifest') throw new Error('manifest links ' + links);
  const m = await (await ap.request.get(new URL(links[0], DEMO).href)).json();
  if (m.id !== '/admin/' || m.scope !== '/admin/' || m.start_url !== '/admin/' || m.name !== 'إدارة الحلقة') throw new Error(JSON.stringify(m).slice(0, 200));
  for (const i of m.icons) { const r = await ap.request.get(new URL(i.src, DEMO).href); if (!r.ok()) throw new Error('icon ' + i.src); }
  await ap.locator('#ad-email').waitFor();  // the admin sign-in, not the learners' app
  const learner = await (await ap.request.get(new URL('/manifest.webmanifest', DEMO).href)).json();
  if (learner.id === m.id) throw new Error('same app id as the learners app');
  await ap.waitForFunction(() => navigator.serviceWorker.ready.then(() => true), null, { timeout: 15000 });
  const cdp = await actx.newCDPSession(ap);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  if (installabilityErrors.length) throw new Error(JSON.stringify(installabilityErrors));
  await ap.goto(DEMO + '#/admin');  // old links move to /admin/
  await ap.waitForURL((u) => u.pathname.startsWith('/admin/'));
});
await actx.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await ctx.close(); await lctx.close();
