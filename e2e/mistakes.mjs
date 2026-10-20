// Student mistakes tracking (pack prompt 33): the teacher records a learning point at an ayah; the student is notified,
// sees it in «أخطائي» with the note and guidance and opens the ayah in the Mushaf; the teacher creates a follow-up
// task and marks it corrected; the parent sees a summary without the teacher's free text.
//   node e2e/mistakes.mjs <shots> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const NOTE = 'انتبه لمد المنفصل في هذه الآية'; const GUIDE = 'مدّه أربع حركات واستمع للتلاوة مرتين'; const INTERNAL = 'سرّي للمعلم';
async function session(email, hello) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
  const page = await ctx.newPage(); page.setDefaultTimeout(10000);
  const app = page.locator('main#scr');
  await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.locator('#lg-email').fill(email); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText(hello).first().waitFor();
  return { ctx, page, app };
}
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${out}/mistakes-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const nav = (x, name) => x.page.getByRole('navigation').getByRole('button', { exact: true, name }).click();

const T = await session('teacher@halqa.app', 'مرحبًا، الشيخ عبدالرحمن السالم');
await step(T.page, 'teacher records a mistake for a student (validation first)', async () => {
  await nav(T, 'الطلاب');
  await T.app.getByRole('button', { name: /يوسف أحمد/ }).first().click();
  await T.app.getByRole('heading', { name: 'الأخطاء ونقاط المراجعة' }).waitFor();
  await T.app.getByRole('button', { name: 'إضافة خطأ' }).click();
  await T.app.getByRole('button', { exact: true, name: 'حفظ الخطأ' }).click();
  await T.app.getByText('اختر نوع الخطأ.').waitFor();
  await T.app.getByRole('radio', { name: 'المدود' }).click();
  await T.app.getByLabel('السورة').selectOption('67');
  await T.app.getByLabel('الآية').selectOption('3');
  await T.app.getByRole('button', { exact: true, name: 'مهم' }).click();
  await T.app.getByLabel('ملاحظة للطالب').fill(NOTE);
  await T.app.getByLabel('التوجيه (كيف يصحّحه)').fill(GUIDE);
  await T.app.getByLabel('ملاحظة داخلية (للمعلمين والإدارة فقط)').fill(INTERNAL);
  await T.app.getByRole('button', { exact: true, name: 'حفظ الخطأ' }).click();
  await T.page.getByText('حُفظت الملاحظة وأُبلغ الطالب').waitFor();
  const c = T.app.getByTestId('correction').first();
  await c.getByText('سورة الملك · الآية 3').waitFor(); await c.getByText(INTERNAL, { exact: false }).waitFor();
});
await T.page.screenshot({ path: out + '/mistakes-teacher.png' });

const S = await session('yousef@halqa.app', 'السلام عليكم، يوسف');
await step(S.page, 'student is notified and sees the point with note and guidance (no internal note)', async () => {
  await S.app.getByRole('button', { name: /الإشعارات/ }).first().click();
  await S.app.getByText('أضاف معلمك ملاحظة جديدة للمراجعة').first().click();
  await S.app.getByRole('heading', { name: 'أخطائي' }).or(S.page.getByText('أخطائي').first()).first().waitFor();
  const c = S.app.getByTestId('correction').first();
  await c.getByText('المدود').waitFor(); await c.getByText(NOTE).waitFor(); await c.getByText(GUIDE, { exact: false }).waitFor();
  if (await S.app.getByText(INTERNAL, { exact: false }).count()) throw new Error('internal note visible to the student');
});
await S.page.screenshot({ path: out + '/mistakes-student.png' });
await step(S.page, 'student opens the ayah in the Mushaf', async () => {
  await S.app.getByTestId('correction').first().getByRole('button', { name: 'افتح في المصحف' }).click();
  await S.page.locator('#ayah-3').waitFor();
});
await step(S.page, 'progress shows the summary, not a score', async () => {
  await S.page.goto(BASE); await S.app.getByText('السلام عليكم، يوسف').waitFor();
  await nav(S, 'تقدمي');
  await S.app.getByRole('heading', { name: 'نقاط للمراجعة' }).waitFor();
  await S.app.getByText('أكثر ما يحتاج انتباهًا: المدود (1)').waitFor();
});

await step(T.page, 'teacher creates a follow-up task, then marks it corrected', async () => {
  const c = T.app.getByTestId('correction').first();
  await c.getByRole('button', { name: 'أنشئ مهمة متابعة' }).click();
  await T.page.getByText('أُنشئت مهمة متابعة للطالب').waitFor();
  await c.getByText('يتحسن').first().waitFor();
  await c.getByRole('button', { exact: true, name: 'تم التصحيح' }).click();
  await T.page.getByText('سُجّل التصحيح').waitFor();
  await c.getByRole('button', { name: 'إعادة فتح' }).waitFor();
});

await step(S.page, 'student sees it under «تم تصحيحها»', async () => {
  await S.app.getByRole('button', { name: 'أخطائي' }).click();
  await S.app.getByText('لا توجد نقاط تحتاج مراجعة الآن. أحسنت!').waitFor();
  await S.app.getByRole('button', { name: 'تم تصحيحها' }).click();
  await S.app.getByTestId('correction').first().getByText('تم التصحيح').waitFor();
});

const P = await session('parent@halqa.app', 'متابعة');
await step(P.page, 'parent sees a safe summary only', async () => {
  await P.app.getByRole('tab', { name: /يوسف/ }).click();
  await P.app.getByRole('heading', { name: 'نقاط المراجعة من المعلم' }).waitFor();
  for (const t of [NOTE, GUIDE, INTERNAL]) if (await P.app.getByText(t, { exact: false }).count()) throw new Error('teacher text visible to parent: ' + t);
});
await P.page.screenshot({ path: out + '/mistakes-parent.png' });
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
