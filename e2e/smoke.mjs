// Post-deploy smoke test against any URL (e.g. https://<name>.onrender.com/):
//   node e2e/smoke.mjs <shots-dir> <base-url>
// Signs up a throwaway student (needs open sign-up), checks the PWA is installable and that the
// configured/unconfigured features behave honestly. Creates one test account per run.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const out = process.argv[2]; const BASE = process.argv[3];
if (!BASE) { console.error('usage: node e2e/smoke.mjs <shots-dir> <base-url>'); process.exit(2); }
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'halqa-smoke-')), {
  executablePath: process.env.CHROMIUM_PATH || undefined, viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], permissions: ['microphone'],
});
const page = ctx.pages()[0] ?? await ctx.newPage(); page.setDefaultTimeout(60000); // a free server may need ~1 min to wake
const app = page.locator('main#scr'); let fails = 0;
const gh = (level, msg) => { if (process.env.GITHUB_ACTIONS) console.log(`::${level} title=smoke::${msg.replace(/\n/g, ' ')}`); };
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); gh('notice', `OK ${name}`); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); gh('error', `FAIL ${name}: ${e.message.split('\n')[0]}`); await page.screenshot({ path: `${out}/smoke-fail-${name.replace(/\W+/g, '_')}.png` }); } };
let ready = {};
await step('server ready', async () => {
  const r = await page.request.get(new URL('/api/ready', BASE).href, { timeout: 90000 });
  ready = await r.json();
  if (ready.status !== 'ok') throw new Error(JSON.stringify(ready));
  console.log('      features:', JSON.stringify(ready.features));
  gh('notice', `features ${JSON.stringify(ready.features)}`);
});
await page.goto(BASE);
await step('PWA installable (service worker + manifest)', async () => {
  await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true));
  const cdp = await ctx.newCDPSession(page);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  if (installabilityErrors.length) throw new Error(JSON.stringify(installabilityErrors));
});
await step('sign up a student and finish onboarding', async () => {
  await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.getByRole('button', { name: 'أنشئ حساب طالب' }).click();
  await app.locator('#su-name').fill('اختبار النشر'); await app.locator('#su-email').fill(`smoke+${Date.now()}@example.com`);
  await app.locator('#su-pw').fill('Smoke-Test-2026!'); await app.getByRole('button', { exact: true, name: 'إنشاء الحساب' }).click();
  for (const pick of ['مبتدئ', '3 أسطر يوميًا']) {
    await app.getByRole('radio', { name: new RegExp(pick) }).first().click();
    await app.getByRole('button', { exact: true, name: 'التالي' }).click();
  }
  await app.getByRole('button', { exact: true, name: 'ابدأ رحلتك' }).click();
  await app.getByText(/السلام عليكم/).waitFor();
});
await page.screenshot({ path: out + '/smoke-home.png' });
await step('Mushaf reports Quran text honestly', async () => {
  await page.getByRole('navigation').getByRole('button', { exact: true, name: 'الرئيسية' }).click();
  await app.getByRole('button', { name: /افتح المصحف/ }).click();
  if (ready.features?.quran_text === 'imported') await app.locator('[id^="ayah-"]').first().waitFor();
  else await app.getByText('النص القرآني غير متاح حاليًا من المصدر المعتمد.').waitFor();
});
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await ctx.close();
