// PWA update during a recording (pack prompt 29): a new version is published while the student is recording.
// "Update now" must not reload over the recording; the update applies itself after the recording is submitted.
// Runs on the live preview build (default http://localhost:4175/) with a fake microphone:
//   NEW_VERSION_CMD='<shell that publishes a changed sw.js>' node e2e/pwa-update.mjs <shots> [liveUrl]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const out = process.argv[2]; const LIVE = (process.argv[3] || 'http://localhost:4175/').replace(/\/?$/, '/');
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'halqa-upd-')), {
  executablePath: process.env.CHROMIUM_PATH || undefined, viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], permissions: ['microphone'],
});
const page = ctx.pages()[0] ?? await ctx.newPage(); page.setDefaultTimeout(15000);
const app = page.locator('main#scr');
let loads = 0; page.on('load', () => { loads++; });
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${out}/upd-fail-${name.replace(/\W+/g, '_')}.png` }); } };

await page.goto(LIVE);
await step('installed app is controlled by the service worker', async () => {
  await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
});
await step('student signs in and starts recording', async () => {
  await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.locator('#lg-email').fill('yousef@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText('السلام عليكم، يوسف').waitFor();
  await page.getByRole('button', { exact: true, name: 'تعلمي' }).click();
  await app.getByText('حفظ سورة الملك').click();
  await app.getByRole('button', { name: /سجّل تلاوتك/ }).click();
  await app.getByRole('button', { name: 'ابدأ التسجيل' }).click();
  await app.getByRole('button', { name: /إنهاء التسجيل/ }).waitFor();
});
await step('a new version is offered while recording', async () => {
  execSync(process.env.NEW_VERSION_CMD || 'true', { stdio: 'inherit' });
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r && r.update()));
  await page.getByText('يتوفر إصدار جديد من التطبيق.').waitFor({ timeout: 30000 });
});
let before = 0;
await step('"update now" waits instead of reloading over the recording', async () => {
  before = loads;
  await page.getByRole('button', { name: 'حدّث الآن' }).click();
  await page.getByText('سيُحدَّث التطبيق تلقائيًا بعد إرسال تسجيلك أو حذفه.').waitFor();
  await page.waitForTimeout(3000);
  if (loads !== before) throw new Error('the page reloaded during the recording');
  await app.getByRole('button', { name: /إنهاء التسجيل/ }).waitFor();          // still recording
});
await page.screenshot({ path: out + '/pwa-update-waiting.png' });
await step('recording is submitted, then the update applies itself', async () => {
  await app.getByRole('button', { name: /إنهاء التسجيل/ }).click();
  await app.getByText('استمع قبل التسليم').waitFor();
  if (loads !== before) throw new Error('reloaded while the recording was waiting to be sent');
  await app.getByRole('button', { name: /تسليم التلاوة/ }).click();
  await app.getByText('تم تسليم تلاوتك').waitFor({ timeout: 20000 });
  for (let i = 0; i < 20 && loads === before; i++) await page.waitForTimeout(500);
  if (loads === before) throw new Error('the update did not apply after the submission');
});
await step('the submission survived the update', async () => {
  const r = await page.request.get(LIVE + 'api/v1/assignments');
  const list = await r.json(); const items = list.results || list;
  const t = items.find((x) => x.title === 'حفظ سورة الملك');
  if (!t || t.status !== 'submitted') throw new Error(`task status ${t && t.status}`);
});
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await ctx.close();
