// Quran reader in live mode (pack prompt 28, journey 7): what the Mushaf renders is exactly the server's verified,
// imported text, nothing else. The text is never hard-coded here: the check compares the screen with the API.
//   node e2e/quran.mjs <shots-dir> [base-url]
// With no imported source, the reader must show the honest "not available" state instead (no fallback text).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
const page = await ctx.newPage(); page.setDefaultTimeout(10000);
const app = page.locator('main#scr');
const external = [];
page.on('request', (r) => { const u = new URL(r.url()); if (!['localhost', '127.0.0.1'].includes(u.hostname) && !u.hostname.endsWith('gstatic.com') && !u.hostname.endsWith('googleapis.com')) external.push(u.hostname); });
let surahResponse = new Promise((res) => page.on('response', async (r) => {
  if (/\/api\/v1\/quran\/surahs\/\d+$/.test(new URL(r.url()).pathname) && r.ok()) res(await r.json());
}));
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${out}/quran-fail-${name.replace(/\W+/g, '_')}.png` }); } };

const ready = await (await page.request.get(BASE + 'api/ready')).json();
const imported = ready.features?.quran_text === 'imported';
await page.goto(BASE);
await step('student signs in', async () => {
  await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.locator('#lg-email').fill('yousef@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText('السلام عليكم، يوسف').waitFor();
});
await step(imported ? 'Mushaf renders the server text exactly' : 'Mushaf says the text is unavailable (no fallback)', async () => {
  await app.getByRole('button', { name: /افتح المصحف/ }).click();
  if (!imported) { await app.getByText('النص القرآني غير متاح حاليًا من المصدر المعتمد.').waitFor(); return; }
  await app.locator('[id^="ayah-"]').first().waitFor();
  const served = await surahResponse;                             // the exact JSON the app received
  const shown = await app.locator('[id^="ayah-"]').evaluateAll((els) => els.map((e) => ({ n: +e.id.split('-').pop(), text: e.textContent })));
  if (!served?.ayahs?.length) throw new Error('the app did not load a surah from /api/v1/quran/surahs/<n>');
  const byN = new Map(served.ayahs.map((a) => [a.number, a.text]));
  const checked = shown.filter((x) => byN.has(x.n));
  if (checked.length < Math.min(3, served.ayahs.length)) throw new Error(`only ${checked.length} rendered ayahs map to the served surah`);
  const bad = checked.filter((x) => !x.text.includes(byN.get(x.n)));
  if (bad.length) throw new Error(`ayah ${bad[0].n} on screen differs from the server text`);
  console.log(`     surah ${served.surah.number}: ${checked.length} ayahs on screen equal the served text`);
});
await step('no third-party Quran text requests in live mode', async () => {
  const q = external.filter((h) => /alquran|quran/i.test(h));
  if (q.length) throw new Error('requested ' + [...new Set(q)].join(', '));
});
await page.screenshot({ path: out + '/quran-reader.png' });
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
