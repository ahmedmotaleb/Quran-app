// Live learning loop: student records (fake mic) → upload + submit → teacher reviews → student sees feedback.
// Run: backend on :8000 with `seed_dev`, then `VITE_API_BASE_URL=/ npx vite --port 5174`, then
//   node e2e/<file>.mjs <screenshot-dir> [base-url]
// Needs Playwright (PLAYWRIGHT_MODULE overrides the import, CHROMIUM_PATH the browser).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = 'http://localhost:5174/';
const b = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
let fails = 0; const errs = [];
async function session(email) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo', permissions: ['microphone'] });
  const page = await ctx.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errs.push(email + ' pageerror: ' + e.message));
  const app = page.locator('main#scr');
  await page.goto(BASE);
  await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.locator('#lg-email').fill(email); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  return { page, app, ctx };
}
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${out}/fail-${name.replace(/\W+/g, '_')}.png` }); } };

const S = await session('yousef@halqa.app');
await S.app.getByText('السلام عليكم، يوسف').waitFor();
await step(S.page, 'student opens task → recorder', async () => {
  await S.page.getByRole('button', { exact: true, name: 'تعلمي' }).click();
  await S.app.getByText('حفظ سورة الملك').click();
  await S.app.getByRole('button', { name: /سجّل تلاوتك/ }).click();
  if (await S.app.getByText('استخدم تسجيلًا تجريبيًا').count()) throw new Error('demo recording offered in live mode');
});
await step(S.page, 'record 5s with (fake) microphone', async () => {
  await S.app.getByRole('button', { name: 'ابدأ التسجيل' }).click();
  await S.page.waitForTimeout(5200);
  await S.app.getByRole('button', { name: /إنهاء التسجيل/ }).click();
  await S.app.getByText('استمع قبل التسليم').waitFor();
});
await step(S.page, 'upload + submit to server', async () => {
  await S.app.getByRole('button', { name: /تسليم التلاوة/ }).click();
  await S.app.getByText('تم تسليم تلاوتك').waitFor({ timeout: 20000 });
  await S.app.getByText('رُفع التسجيل إلى الخادم ويراه معلمك فقط.').waitFor();
});
await S.page.screenshot({ path: out + '/m1-submitted.png' });

const T = await session('teacher@halqa.app');
await step(T.page, 'teacher sees live queue (no sample sessions)', async () => {
  await T.app.getByText('مرحبًا، الشيخ عبدالرحمن السالم').waitFor();
  await T.app.getByText('يوسف أحمد · حفظ سورة الملك').waitFor();
  if (await T.app.getByText('عمر الحربي').count()) throw new Error('sample sessions shown');  // demo-only names
});
await T.page.screenshot({ path: out + '/m2-teacher-dash.png' });
await step(T.page, 'teacher plays the real recording', async () => {
  await T.app.getByText('يوسف أحمد · حفظ سورة الملك').click();
  await T.app.getByRole('heading', { name: 'مراجعة التسجيل' }).waitFor().catch(() => {});
  const [resp] = await Promise.all([
    T.page.waitForResponse((r) => r.url().includes('/content?t='), { timeout: 8000 }),
    T.app.getByRole('button', { name: /تشغيل|play/i }).first().click(),
  ]);
  if (resp.status() !== 200) throw new Error('audio status ' + resp.status());
  await T.page.waitForTimeout(1500);
});
await step(T.page, 'teacher adds timed note, scores, requests repeat', async () => {
  await T.app.getByRole('button', { name: /أضف ملاحظة عند/ }).click();
  await T.app.locator('#rv-draft').fill('انتبه لمدّ المنفصل هنا');
  await T.app.getByRole('button', { exact: true, name: 'حفظ الملاحظة' }).click().catch(async () => { await T.app.getByRole('button', { name: /حفظ/ }).first().click(); });
  for (const [l, n] of [['الحفظ', 4], ['التجويد', 3], ['الطلاقة', 4]]) await T.app.getByRole('radio', { name: new RegExp(`^${l}: ${n} من 5`) }).click();
  await T.app.getByRole('button', { exact: true, name: 'يحتاج إعادة' }).click();
  await T.app.getByRole('button', { name: /إرسال التقييم للطالب/ }).click();
  await T.app.getByText('حدّد ما يحتاج الطالب إلى إعادته').waitFor();
  await T.app.locator('#rv-needs').fill('الآيات 6–8');
  await T.app.getByRole('button', { name: /إرسال التقييم للطالب/ }).click();
  await T.page.getByText('أُرسل التقييم إلى يوسف أحمد').waitFor();
});
await T.page.screenshot({ path: out + '/m3-teacher-sent.png' });
await step(T.page, 'teacher assigns new task (Cairo time)', async () => {
  await T.page.getByRole('button', { exact: true, name: 'الطلاب' }).click();
  await T.app.getByText('يوسف أحمد').click();
  await T.app.getByRole('button', { name: /أنشئ واجبًا لـ/ }).click();
  await T.app.locator('#af-s').selectOption('78');
  await T.app.locator('#af-from').fill('1'); await T.app.locator('#af-to').fill('16');
  await T.app.getByRole('button', { name: /إرسال الواجب إلى يوسف أحمد/ }).click();
  await T.page.getByText('أُرسل الواجب إلى يوسف أحمد').waitFor();
});

await step(S.page, 'student sees needs-repeat + teacher feedback', async () => {
  await S.page.reload();
  await S.app.getByText('السلام عليكم، يوسف').waitFor();
  await S.page.getByRole('button', { exact: true, name: 'تعلمي' }).click();
  await S.app.getByText('حفظ سورة الملك').click();
  await S.app.getByText('مطلوب الإعادة').first().waitFor();
  await S.app.getByRole('button', { name: /عرض تقييم المعلم/ }).click();
  await S.app.getByText('يحتاج إلى إعادة').waitFor();
  await S.app.getByText('انتبه لمدّ المنفصل هنا').waitFor();
  await S.app.getByText('4 من 5').first().waitFor();
});
await S.page.screenshot({ path: out + '/m4-student-feedback.png', fullPage: true });
await step(S.page, 'student sees the newly assigned task', async () => {
  await S.page.getByRole('button', { name: /رجوع/ }).first().click();
  await S.page.getByRole('button', { name: /رجوع/ }).first().click();
  await S.app.getByRole('tab', { name: /حفظ/ }).click();
  await S.app.getByText('حفظ سورة النبأ').first().waitFor();
});
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no page errors');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
await b.close();
