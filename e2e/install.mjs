// «ثبّت تطبيق الحلقة» bottom sheet: when it shows (Android with the browser's install offer, iPhone Safari), when it
// never shows (installed, standalone, Home Screen, desktop), the real prompt() call and the person's choice, «لاحقًا»
// with a 7-day cooldown, layout above the tab bar, RTL at 320 px, and no notification permission request.
// The browser's `beforeinstallprompt` is dispatched with a controlled userChoice (Chrome's real installability is
// checked in pwa.mjs).   node e2e/install.mjs <shots> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); if (p) await p.screenshot({ path: `${out}/install-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const UA = {
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
};
const DAY = 86_400_000;

/** A page as `kind` (android | iphone | desktop); `standalone` = running installed; `storage` = local state before load. */
async function open(kind, { standalone = false, storage = {}, width = 390 } = {}) {
  const ctx = await b.newContext({ userAgent: UA[kind], viewport: { width, height: 800 }, isMobile: kind !== 'desktop', hasTouch: kind !== 'desktop', timezoneId: 'Africa/Cairo' });
  await ctx.addInitScript(({ standalone, storage, ios }) => {
    for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
    if (standalone) {
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q) => (q.includes('display-mode: standalone') ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : mm(q));
      if (ios) Object.defineProperty(navigator, 'standalone', { get: () => true });
    }
    // Installing must never ask for notification permission.
    window.__perm = 0;
    if (window.Notification) window.Notification.requestPermission = async () => { window.__perm++; return 'default'; };
  }, { standalone, storage, ios: kind === 'iphone' });
  const page = await ctx.newPage(); page.setDefaultTimeout(8000);
  await page.goto(BASE);
  await page.locator('main#scr').getByRole('button', { exact: true, name: 'تخطَّ' }).click();   // intro → sign-in (a main screen)
  await page.locator('#lg-email').waitFor();
  return { ctx, page };
}
/** The browser offers installation; `outcome` is what the person picks in its dialog. */
const offer = (page, outcome = 'accepted') => page.evaluate((outcome) => {
  window.__prompted = 0;
  const e = new Event('beforeinstallprompt', { cancelable: true });
  e.prompt = async () => { window.__prompted++; if (outcome === 'accepted') setTimeout(() => window.dispatchEvent(new Event('appinstalled')), 50); };
  e.userChoice = Promise.resolve({ outcome, platform: 'web' });
  window.dispatchEvent(e);
}, outcome);
const sheet = (page) => page.getByTestId('install-sheet');
const none = async (page, why) => { await page.waitForTimeout(400); if (await sheet(page).count()) throw new Error('install sheet shown: ' + why); };

await step(null, '1. Android Chrome, not installed: sheet appears once the browser offers installation', async () => {
  const { ctx, page } = await open('android');
  await none(page, 'before the browser offered installation');
  await offer(page);
  const s = sheet(page); await s.waitFor();
  await s.getByRole('heading', { name: 'ثبّت تطبيق الحلقة' }).waitFor();
  await s.getByText('ثبّت التطبيق على جهازك للوصول بشكل أسرع واستقبال الإشعارات بسهولة.').waitFor();
  await s.getByRole('button', { name: 'تثبيت التطبيق' }).waitFor(); await s.getByRole('button', { exact: true, name: 'لاحقًا' }).waitFor();
  if (!(await s.locator('img[src="/icons/icon-192.png"]').count())) throw new Error('no app icon');
  await page.screenshot({ path: out + '/install-android.png' });
  await ctx.close();
});
await step(null, '2. Android Chrome, already installed from this browser: no sheet', async () => {
  const { ctx, page } = await open('android', { storage: { 'halqa.install.installed': '1' } });
  await offer(page); await none(page, 'installed');
  await ctx.close();
});
await step(null, '3. Android installed PWA (standalone): no sheet', async () => {
  const { ctx, page } = await open('android', { standalone: true });
  await offer(page); await none(page, 'standalone');
  await ctx.close();
});
await step(null, '4–5. «تثبيت التطبيق» opens the browser dialog; accepted → sheet gone for good, no permission asked', async () => {
  const { ctx, page } = await open('android');
  await offer(page, 'accepted');
  await sheet(page).getByRole('button', { name: 'تثبيت التطبيق' }).click();
  await page.getByText('ثُبّت تطبيق الحلقة على جهازك').waitFor();
  await none(page, 'after installing');
  if ((await page.evaluate(() => window.__prompted)) !== 1) throw new Error('prompt() not called exactly once');
  if ((await page.evaluate(() => localStorage.getItem('halqa.install.installed'))) !== '1') throw new Error('installed state not kept');
  if (await page.evaluate(() => window.__perm)) throw new Error('notification permission requested during install');
  await page.reload(); await page.locator('main#scr').getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await offer(page); await none(page, 'after reload when installed');
  await ctx.close();
});
await step(null, '6. cancelled in the browser dialog: sheet hidden, not shown again on reload', async () => {
  const { ctx, page } = await open('android');
  await offer(page, 'dismissed');
  await sheet(page).getByRole('button', { name: 'تثبيت التطبيق' }).click();
  await none(page, 'after cancelling');
  if ((await page.evaluate(() => window.__prompted)) !== 1) throw new Error('prompt() not called');
  await page.reload(); await page.locator('main#scr').getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await offer(page, 'dismissed'); await none(page, 'right after a cancel');
  await ctx.close();
});
await step(null, '7–8. «لاحقًا» hides it; the 7-day cooldown holds across reloads and ends after 7 days', async () => {
  const { ctx, page } = await open('android');
  await offer(page); await sheet(page).getByRole('button', { exact: true, name: 'لاحقًا' }).click();
  await none(page, 'after «لاحقًا»');
  const t = Number(await page.evaluate(() => localStorage.getItem('halqa.install.later')));
  if (!(Date.now() - t < 60_000)) throw new Error('later time not stored');
  await page.reload(); await page.locator('main#scr').getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await offer(page); await none(page, '1 minute after «لاحقًا»');
  await ctx.close();
  const six = await open('android', { storage: { 'halqa.install.later': String(Date.now() - 6 * DAY) } });
  await offer(six.page); await none(six.page, '6 days after «لاحقًا»'); await six.ctx.close();
  const eight = await open('android', { storage: { 'halqa.install.later': String(Date.now() - 8 * DAY) } });
  await offer(eight.page); await sheet(eight.page).waitFor(); await eight.ctx.close();
  const x = await open('android');                                               // the × does the same as «لاحقًا»
  await offer(x.page); await sheet(x.page).getByRole('button', { name: 'إغلاق اقتراح التثبيت' }).click(); await none(x.page, 'after ×'); await x.ctx.close();
});
await step(null, '9. iPhone Safari: Share → «إضافة إلى الشاشة الرئيسية» guidance, no fake install button', async () => {
  const { ctx, page } = await open('iphone');
  const s = sheet(page); await s.waitFor();
  await s.getByText('لتثبيت الحلقة على جهازك، اضغط زر المشاركة ثم اختر «إضافة إلى الشاشة الرئيسية».').waitFor();
  await s.getByRole('list', { name: 'خطوات التثبيت' }).waitFor();
  if (await s.getByRole('button', { name: 'تثبيت التطبيق' }).count()) throw new Error('iOS shows an install button');
  await page.screenshot({ path: out + '/install-iphone.png' });
  await s.getByRole('button', { exact: true, name: 'لاحقًا' }).click(); await none(page, 'after «لاحقًا» on iPhone');
  await ctx.close();
});
await step(null, '10. iPhone Home Screen app (standalone): no guidance', async () => {
  const { ctx, page } = await open('iphone', { standalone: true });
  await none(page, 'iOS standalone');
  await ctx.close();
});
await step(null, '11. desktop browser: no sheet (the browser’s own install icon and «حسابي» remain)', async () => {
  const { ctx, page } = await open('desktop', { width: 1280 });
  await offer(page); await none(page, 'desktop');
  await ctx.close();
});
await step(null, '12. RTL at 320 px: no sideways scroll, ≥44 px targets, above the tab bar on the home screen', async () => {
  const { ctx, page } = await open('android', { width: 320 });
  await page.locator('#lg-email').fill('yousef@halqa.app'); await page.locator('#lg-pw').fill('halqa123');
  await page.locator('main#scr').getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await page.getByText('السلام عليكم، يوسف').waitFor();
  await offer(page);
  const s = sheet(page); await s.waitFor();
  await page.evaluate(() => Promise.all(document.getAnimations().map((x) => x.finished)));   // measure after the entrance animation
  const dir = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="install-sheet"]')).direction);
  if (dir !== 'rtl') throw new Error('direction ' + dir);
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('horizontal scroll at 320 px');
  for (const n of ['تثبيت التطبيق', 'لاحقًا', 'إغلاق اقتراح التثبيت']) {
    const bb = await s.getByRole('button', { name: n, exact: n === 'لاحقًا' }).boundingBox();
    if (!bb || bb.height < 44 || bb.width < 44) throw new Error(`small target «${n}»: ${JSON.stringify(bb)}`);
  }
  const sb = await s.boundingBox(); const nav = await page.getByRole('navigation', { name: 'التنقل الرئيسي' }).boundingBox();
  if (!nav || sb.y + sb.height > nav.y + 1) throw new Error(`sheet overlaps the tab bar: ${JSON.stringify({ sb, nav })}`);
  await page.screenshot({ path: out + '/install-320-home.png' });
  await ctx.close();
});

console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
