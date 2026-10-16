// Mushaf reading tools (pack prompt 20): bookmarks with private labels and the reading position follow the student
// across devices through the server; bookmarks jump across surahs; the verified source is named.
//   node e2e/reading.mjs <shots-dir> [base-url]
// Needs the verified Quran text imported (CI imports it from Tanzil); without it the suite reports SKIPPED.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
async function device() {
  const page = await (await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' })).newPage(); page.setDefaultTimeout(10000);
  const app = page.locator('main#scr');
  await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.locator('#lg-email').fill('yousef@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText('السلام عليكم، يوسف').waitFor();
  return { page, app };
}
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${out}/reading-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const get = async (p, path) => (await p.request.get(BASE + 'api/v1/' + path)).json();
const openMushaf = async (D) => { await D.page.getByRole('navigation').getByRole('button', { exact: true, name: 'الرئيسية' }).click(); await D.app.getByRole('button', { name: /افتح المصحف/ }).click(); await D.app.locator('[id^="ayah-"]').first().waitFor(); };
const inView = (p, id) => p.evaluate((i) => { const el = document.getElementById(i); if (!el) return false; const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < window.innerHeight; }, id);

const ready = await (await (await b.newContext()).request.get(BASE + 'api/ready')).json();
if (ready.features?.quran_text !== 'imported') {
  console.log('SKIPPED: no verified Quran text in this environment (CI imports it).');
  await b.close(); process.exit(0);
}
const A = await device();
await step(A.page, 'the verified source is named under the text', async () => {
  await openMushaf(A);
  await A.app.getByText(/النص: .*Tanzil|النص: .*تنزيل/i).waitFor();
  if (await A.app.getByText(/alquran\.cloud/).count()) throw new Error('live mode still credits alquran.cloud');
});
await step(A.page, 'bookmark an ayah; it survives a reload', async () => {
  await A.app.locator('#ayah-5').click();
  await A.page.getByRole('button', { name: 'ضع علامة مرجعية' }).click();
  await A.page.getByText('حُفظت العلامة عند الآية 5').waitFor();
  await A.page.reload(); await A.app.getByText('السلام عليكم، يوسف').waitFor(); await openMushaf(A);
  await A.page.getByRole('button', { name: 'علاماتي (1)' }).waitFor();
});
await step(A.page, 'give the bookmark a private label', async () => {
  await A.page.getByRole('button', { name: /^علاماتي/ }).click();
  await A.page.getByRole('button', { name: /وصف العلامة عند سورة .* الآية 5/ }).click();
  await A.page.getByLabel('وصف خاص بك (اختياري)').fill('بداية حفظ الأسبوع');
  await A.page.getByRole('button', { exact: true, name: 'حفظ' }).click();
  await A.page.getByText('بداية حفظ الأسبوع').waitFor();
  const marks = await get(A.page, 'quran/bookmarks');
  if (marks.length !== 1 || marks[0].label !== 'بداية حفظ الأسبوع' || 'text' in marks[0]) throw new Error(JSON.stringify(marks));
  await A.page.keyboard.press('Escape');
});
await step(A.page, 'reading further is saved as the position', async () => {
  await A.app.locator('#m-jump').fill('20'); await A.app.getByRole('button', { exact: true, name: 'انتقل' }).click();
  await A.page.waitForTimeout(3500);
  const pos = await get(A.page, 'quran/position');
  if (pos.surah !== 67 || pos.ayah < 15 || pos.ayah > 22) throw new Error(`position ${pos.surah}:${pos.ayah}`);
});
const B = await device(); // the same student on another device
await step(B.page, 'another device opens the Mushaf where the reader stopped', async () => {
  await openMushaf(B);
  const pos = await get(B.page, 'quran/position');
  await B.page.waitForTimeout(800);
  if (!(await inView(B.page, `ayah-${pos.ayah}`))) throw new Error(`ayah ${pos.ayah} not brought into view`);
});
await step(B.page, 'a bookmark in another surah opens that surah at the ayah', async () => {
  const r = await B.page.evaluate(async () => {
    const csrf = (await (await fetch('/api/v1/auth/csrf', { credentials: 'include' })).json()).csrfToken;
    return (await fetch('/api/v1/quran/bookmarks', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf }, body: JSON.stringify({ surah: 2, ayah: 255 }) })).status;
  });
  if (r !== 201) throw new Error('create ' + r);
  await B.page.reload(); await B.app.getByText('السلام عليكم، يوسف').waitFor(); await openMushaf(B);
  await B.page.getByRole('button', { name: 'علاماتي (2)' }).click();
  await B.page.getByRole('button', { name: /البقرة · الآية 255/ }).click();
  await B.app.locator('#ayah-255').waitFor();
  await B.page.waitForTimeout(600);
  if (!(await inView(B.page, 'ayah-255'))) throw new Error('ayah 255 not in view');
});
await B.page.screenshot({ path: out + '/reading.png' });
await step(B.page, 'remove a bookmark', async () => {
  await B.page.getByRole('button', { name: 'علاماتي (2)' }).click();
  await B.page.getByRole('button', { name: /حذف العلامة عند سورة البقرة الآية 255/ }).click();
  await B.page.getByText('أُزيلت العلامة').waitFor();
  if ((await get(B.page, 'quran/bookmarks')).length !== 1) throw new Error('not removed');
});
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
