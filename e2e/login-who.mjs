// Sign-in asks «من أنت؟» (طالب / معلم / ولي أمر) and shows that sign-in; the account's own role still decides the
// interface. `#/teacher` opens the teacher sign-in directly; the answer is remembered on the device.
//   node e2e/login-who.mjs <shots> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
const page = await ctx.newPage(); page.setDefaultTimeout(10000);
const app = page.locator('main#scr');
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${out}/who-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const q = app.getByRole('group', { name: 'من أنت؟' });

await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
await step('the sign-in asks «من أنت؟» with three answers and no form yet', async () => {
  await q.waitFor();
  for (const n of ['أنا طالب', 'أنا معلم', 'أنا ولي أمر']) await q.getByRole('button', { name: new RegExp(`^${n}`) }).waitFor();
  if (await app.locator('#lg-email').count()) throw new Error('form shown before answering');
  await page.screenshot({ path: out + '/who-question.png' });
});
await step('«أنا معلم» shows the teacher sign-in (no student sign-up); «تغيير» asks again', async () => {
  await q.getByRole('button', { name: /^أنا معلم/ }).click();
  await app.getByRole('heading', { name: 'دخول المعلم' }).waitFor();
  await app.getByText('حساب المعلم تنشئه إدارة الحلقة', { exact: false }).waitFor();
  if (await app.getByRole('button', { name: 'أنشئ حساب طالب' }).count()) throw new Error('student sign-up offered to a teacher');
  await app.getByRole('button', { name: 'لست معلمًا؟ تغيير' }).click(); await q.waitFor();
  await q.getByRole('button', { name: /^أنا طالب/ }).click();
  await app.getByRole('heading', { name: 'دخول الطالب' }).waitFor();
});
await step('a teacher account signed in as «طالب» still opens the teacher interface, with a notice', async () => {
  await app.locator('#lg-email').fill('teacher@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText('مرحبًا، الشيخ عبدالرحمن السالم').first().waitFor();
  await page.getByText('هذا الحساب حساب معلم؛ فُتحت الواجهة المناسبة له.').waitFor();
});
await step('after signing out, the teacher sign-in is remembered on this device', async () => {
  await page.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  await app.getByRole('button', { name: /تسجيل الخروج/ }).click();
  await page.getByRole('button', { name: /تسجيل الخروج/ }).last().click().catch(() => {});
  await app.getByRole('heading', { name: 'دخول المعلم' }).waitFor();
});
await step('`#/teacher` link opens the teacher sign-in directly', async () => {
  const c2 = await b.newContext({ viewport: { width: 390, height: 844 } }); const p2 = await c2.newPage();
  await p2.goto(BASE + '#/teacher');
  await p2.locator('main#scr').getByRole('heading', { name: 'دخول المعلم' }).waitFor({ timeout: 15000 });
  if (new URL(p2.url()).hash) throw new Error('hash kept');
  await c2.close();
});
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
