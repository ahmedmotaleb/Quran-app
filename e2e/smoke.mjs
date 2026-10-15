// Post-deploy smoke test against any URL (e.g. https://halqa-<number>.europe-west1.run.app/):
//   node e2e/smoke.mjs <shots-dir> <base-url>
// Signs up a throwaway student (needs open sign-up), checks the PWA is installable and that the
// configured/unconfigured features behave honestly. Creates one test account per run.
const { chromium, request } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
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
if (ready.features?.media_storage === 'configured') await step('private recording: upload, owner playback, anonymous refused', async () => {
  // A tiny stand-in recording (Ogg signature + padding). It is never attached to a submission, so the
  // purge_orphan_media job removes it later.
  const api = (p) => new URL(`/api/v1/${p}`, BASE).href;
  const { csrfToken } = await (await page.request.get(api('auth/csrf'))).json();
  // ~200 KB, about the size of a short compressed recitation, so the timings below are representative.
  const bytes = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(200 * 1024, 7)]);
  const t0 = Date.now();
  const up = await page.request.post(api('media/recitations'), {
    headers: { 'X-CSRFToken': csrfToken, Referer: BASE },
    multipart: { file: { name: 'smoke.ogg', mimeType: 'audio/ogg', buffer: bytes }, duration_seconds: '20' },
  });
  const uploadMs = Date.now() - t0;
  if (up.status() !== 201) throw new Error(`upload ${up.status()} ${(await up.text()).slice(0, 200)}`);
  const { id } = await up.json();
  const det = await page.request.get(api(`media/${id}`));
  const { url } = await det.json();
  if (!url || !/r2\.cloudflarestorage\.com/.test(url)) throw new Error(`unexpected read URL host: ${url && new URL(url).host}`);
  const t1 = Date.now();
  const got = await page.request.get(url);
  const body = await got.body();
  gh('notice', `storage timing: upload 200 KB via the API (validated, stored in R2) ${uploadMs} ms; signed read from R2 ${Date.now() - t1} ms`);
  if (got.status() !== 200 || !body.equals(bytes)) throw new Error(`playback ${got.status()} (${body.length} bytes)`);
  const anon = await request.newContext();
  const a = await anon.get(api(`media/${id}`));
  if (a.status() < 400) throw new Error(`anonymous read allowed (${a.status()})`);
  const bare = await anon.get(url.split('?')[0]);
  if (bare.status() < 400) throw new Error(`unsigned bucket URL readable (${bare.status()})`);
  await anon.dispose();
});
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await ctx.close();
