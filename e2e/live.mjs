// Live-mode e2e: the real React app against the real Django API + PostgreSQL (seed_dev data).
// Run: backend on :8000 with `seed_dev`, then `VITE_API_BASE_URL=/ npx vite --port 5174`, then
//   node e2e/<file>.mjs <screenshot-dir> [base-url]
// Needs Playwright (PLAYWRIGHT_MODULE overrides the import, CHROMIUM_PATH the browser).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = process.argv[3] || 'http://localhost:5174/';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
const page = await ctx.newPage(); page.setDefaultTimeout(8000);
const errs = []; const api = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
page.on('response', (r) => { if (r.url().includes('/api/v1/')) api.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`); });
const app = page.locator('main#scr');
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${out}/fail-${name.replace(/\W+/g, '_')}.png` }); } };

await page.goto(BASE);
await step('intro→login', async () => { await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click(); await app.getByRole('heading', { exact: true, name: 'تسجيل الدخول' }).waitFor(); });
await step('no demo accounts box in live mode', async () => { if (await app.getByText('حسابات تجريبية').count()) throw new Error('demo box visible'); });
await step('wrong password → server error shown', async () => {
  await app.locator('#lg-email').fill('yousef@halqa.app'); await app.locator('#lg-pw').fill('wrong-password');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.locator('[role=alert], p').filter({ hasText: /غير صحيحة/ }).first().waitFor();
});
await page.screenshot({ path: out + '/l1-bad-login.png' });
await step('admin rejected on learning sign-in', async () => {
  await app.locator('#lg-email').fill('admin@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText(/بوابة الإدارة/).first().waitFor();
});
await step('student login (real API)', async () => {
  await app.locator('#lg-email').fill('yousef@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText('السلام عليكم، يوسف').waitFor();
});
await page.screenshot({ path: out + '/l2-home.png' });
await step('plan shows server tasks', async () => {
  await page.getByRole('button', { exact: true, name: 'تعلمي' }).click();
  await app.getByText('حفظ سورة الملك').waitFor();
  await app.getByRole('tab', { name: /مراجعة/ }).click(); await app.getByText('مراجعة سورة النبأ').waitFor();
});
await page.screenshot({ path: out + '/l3-plan.png' });
await step('teacher directory from API', async () => {
  await page.getByRole('button', { exact: true, name: 'الجلسات' }).click();
  await app.getByText('الشيخ خالد العمري').waitFor(); await app.getByText('2 معلم').waitFor();
});
let picked = '';
await step('open teacher → real slots', async () => {
  await app.getByText('الشيخ عبدالرحمن السالم').click();
  await app.getByText('المواعيد المتاحة').waitFor();
  await app.getByText('جارٍ تحميل المواعيد…').waitFor({ state: 'detached' });
  const slot = app.locator('div[style*="grid"] button:not([disabled])').first();
  picked = (await slot.textContent()).trim(); await slot.click();
});
await page.screenshot({ path: out + '/l4-slots.png' });
await step('review → confirm booking', async () => {
  await app.getByRole('button', { exact: true, name: 'متابعة' }).click();
  await app.getByRole('heading', { name: 'مراجعة الحجز' }).waitFor();
  await app.locator('#bk-note').fill('اختبار حجز حقيقي');
  await app.getByRole('button', { exact: true, name: 'تأكيد الحجز' }).click();
  await app.getByText('تم تأكيد حجزك').waitFor(); await app.getByText('حُفظ الحجز على الخادم.').waitFor();
});
await page.screenshot({ path: out + '/l5-booked.png' });
await step('booking persisted (reload restores session + booking)', async () => {
  await page.reload();
  await app.getByText('السلام عليكم، يوسف').waitFor({ timeout: 6000 });
  await page.getByRole('button', { exact: true, name: 'الجلسات' }).click();
  await app.getByRole('tab', { name: 'حجوزاتي' }).click();
  await app.getByText('الشيخ عبدالرحمن السالم · فردية').first().waitFor();
});
await page.screenshot({ path: out + '/l6-bookings.png' });
await step('same slot is now taken for this student', async () => {
  await app.getByRole('tab', { name: 'المعلمون' }).click();
  await app.getByText('الشيخ عبدالرحمن السالم').click();
  await app.getByText('جارٍ تحميل المواعيد…').waitFor({ state: 'detached' });
  // individual slot capacity 1 → our booked one is now shown as taken
  await app.locator('button[disabled]').filter({ hasText: picked.replace('محجوز', '') }).first().waitFor();
  await page.getByRole('button', { name: /رجوع/ }).first().click();
});
await step('cancel booking', async () => {
  await app.getByRole('tab', { name: 'حجوزاتي' }).click();
  await app.getByText('الشيخ عبدالرحمن السالم · فردية').first().click();
  await app.getByRole('button', { exact: true, name: 'إلغاء الحجز' }).click();
  await page.getByRole('button', { exact: true, name: 'نعم، ألغِ الحجز' }).click();
  await page.getByText('تم إلغاء الحجز').waitFor();
});
await step('cancelled shows in past list', async () => {
  await page.getByRole('button', { name: /رجوع/ }).first().click().catch(() => {});
  await page.getByRole('button', { exact: true, name: 'الجلسات' }).click();
  await app.getByRole('tab', { name: 'حجوزاتي' }).click();
  await app.getByText('السابقة والملغاة').waitFor();
  await app.getByText('ملغاة').first().waitFor();
});
await page.screenshot({ path: out + '/l7-cancelled.png' });
await step('progress is live (no sample banner)', async () => {
  await page.getByRole('button', { exact: true, name: 'تقدمي' }).click();
  await app.getByText('دقائق التلاوة التي سجّلتها وسلّمتها').waitFor();
  if (await page.getByText('محتوى تجريبي —').count()) throw new Error('sample banner shown');
});
await step('logout ends server session', async () => {
  await page.getByRole('button', { exact: true, name: 'حسابي' }).click();
  await app.getByRole('button', { name: /تسجيل الخروج/ }).click();
  await page.getByRole('button', { name: /تسجيل الخروج/ }).last().click().catch(() => {});
  await app.getByRole('heading', { exact: true, name: 'تسجيل الدخول' }).waitFor();
  await page.reload(); await page.waitForTimeout(2600);
  if (await app.getByText('السلام عليكم، يوسف').count()) throw new Error('session survived logout');
});
await step('signup enforces 10-char password, then creates student', async () => {
  await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.getByRole('button', { name: 'أنشئ حساب طالب' }).click();
  await app.locator('#su-name').fill('طالب اختبار'); await app.locator('#su-email').fill(`e2e${Date.now()}@example.com`);
  await app.locator('#su-pw').fill('short123'); await app.getByRole('button', { exact: true, name: 'إنشاء الحساب' }).click();
  await app.getByText('استخدم 10 أحرف على الأقل').waitFor();
  await app.locator('#su-pw').fill('Correct-Horse-9'); await app.getByRole('button', { exact: true, name: 'إنشاء الحساب' }).click();
  await app.getByText(/مستواك|المستوى/).first().waitFor();
});
await page.screenshot({ path: out + '/l8-onboard.png' });
console.log('\nAPI calls:\n ' + [...new Set(api)].join('\n '));
console.log(errs.length ? '\nERRORS:\n' + errs.join('\n') : '\nno page errors');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
await b.close();
