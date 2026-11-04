// Sign-in role choice «طالب / معلم / ولي أمر» (default طالب): each role reaches its own dashboard; a wrong choice for
// طالب/معلم is refused by the server with a clear Arabic error and no session; the parent sign-in is unchanged;
// `#/teacher` opens the teacher sign-in; all three choices visible at 320 and 390 px.   node e2e/login-who.mjs <shots> [base]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${out}/who-fail-${name.replace(/\W+/g, '_')}.png` }); } };
async function open(width = 390, hash = '') {
  const ctx = await b.newContext({ viewport: { width, height: 760 }, timezoneId: 'Africa/Cairo' });
  const page = await ctx.newPage(); page.setDefaultTimeout(10000);
  const app = page.locator('main#scr');
  await page.goto(BASE + hash);
  if (!hash) await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.locator('#lg-email').waitFor({ timeout: 15000 });
  return { ctx, page, app, roles: app.getByRole('radiogroup', { name: 'نوع الحساب' }) };
}
const choose = (x, label) => x.roles.getByRole('radio', { name: label, exact: true }).click();
async function signIn(x, email) {
  await x.app.locator('#lg-email').fill(email); await x.app.locator('#lg-pw').fill('halqa123');
  await x.app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
}
const noSession = async (x) => {
  const s = await x.page.evaluate(async () => (await fetch('/api/v1/me', { credentials: 'include' })).status);
  if (s !== 401 && s !== 403) throw new Error('a session was created: /me ' + s);
};

for (const width of [320, 390]) {
  const x = await open(width);
  await step(x.page, `${width} px: the three roles are visible, طالب by default, touch targets ≥ 44 px, no sideways scroll`, async () => {
    for (const l of ['طالب', 'معلم', 'ولي أمر']) {
      const r = x.roles.getByRole('radio', { name: l, exact: true });
      const bb = await r.boundingBox(); if (!bb || bb.height < 44 || bb.x < 0 || bb.x + bb.width > width) throw new Error(`«${l}» ${JSON.stringify(bb)}`);
    }
    if ((await x.roles.getByRole('radio', { name: 'طالب', exact: true }).getAttribute('aria-checked')) !== 'true') throw new Error('طالب not default');
    await x.app.getByRole('heading', { name: 'تسجيل الدخول', exact: true }).waitFor();
    await x.app.getByRole('button', { name: 'أنشئ حساب طالب' }).waitFor();
    if (await x.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('sideways scroll');
    if ((await x.page.evaluate(() => getComputedStyle(document.querySelector('main#scr')).direction)) !== 'rtl') throw new Error('not RTL');
    await x.page.screenshot({ path: `${out}/login-roles-${width}.png` });
  });
  await x.ctx.close();
}

let x = await open();
await step(x.page, 'teacher: «تسجيل دخول المعلم», no student sign-up, reaches the teacher dashboard', async () => {
  await choose(x, 'معلم');
  await x.app.getByRole('heading', { name: 'تسجيل دخول المعلم' }).waitFor();
  if (await x.app.getByRole('button', { name: 'أنشئ حساب طالب' }).count()) throw new Error('student sign-up shown');
  await x.app.locator('#lg-email').waitFor(); await x.app.locator('#lg-pw').waitFor();
  await x.page.screenshot({ path: `${out}/login-teacher.png` });
  await signIn(x, 'teacher@halqa.app');
  await x.app.getByText('مرحبًا، الشيخ عبدالرحمن السالم').first().waitFor();
  await x.page.getByRole('navigation').getByRole('button', { exact: true, name: 'الطلاب' }).waitFor();   // teacher tabs
});
await step(x.page, 'signing out returns to the teacher sign-in', async () => {
  await x.page.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  await x.app.getByRole('button', { name: /تسجيل الخروج/ }).click();
  await x.page.getByRole('button', { name: /تسجيل الخروج/ }).last().click().catch(() => {});
  await x.app.getByRole('heading', { name: 'تسجيل دخول المعلم' }).waitFor();
});
await x.ctx.close();

x = await open();
await step(x.page, 'student: reaches the student dashboard', async () => {
  await signIn(x, 'yousef@halqa.app');
  await x.app.getByText('السلام عليكم، يوسف').waitFor();
  await x.page.getByRole('navigation').getByRole('button', { exact: true, name: 'تعلمي' }).waitFor();
});
await x.ctx.close();

x = await open();
await step(x.page, 'parent: «تسجيل دخول ولي الأمر» reaches the parent dashboard', async () => {
  await choose(x, 'ولي أمر');
  await x.app.getByRole('heading', { name: 'تسجيل دخول ولي الأمر' }).waitFor();
  await signIn(x, 'parent@halqa.app');
  await x.app.getByRole('heading', { name: 'متابعة الأبناء' }).waitFor();
});
await x.ctx.close();

x = await open();
await step(x.page, 'wrong role: «معلم» with a student account → Arabic error, no session, stays on sign-in', async () => {
  await choose(x, 'معلم'); await signIn(x, 'yousef@halqa.app');
  await x.app.getByText('هذا الحساب لا يملك صلاحية المعلم؛ إنه حساب طالب.', { exact: false }).waitFor();
  await x.app.getByRole('heading', { name: 'تسجيل دخول المعلم' }).waitFor();
  await noSession(x);
});
await step(x.page, 'wrong role: «معلم» with a parent account → refused', async () => {
  await signIn(x, 'parent@halqa.app');
  await x.app.getByText('إنه حساب ولي أمر', { exact: false }).waitFor(); await noSession(x);
});
await step(x.page, 'wrong role: «طالب» with a teacher account → «اختر «معلم»», no session', async () => {
  await choose(x, 'طالب'); await signIn(x, 'teacher@halqa.app');
  await x.app.getByText('هذا حساب معلم. اختر «معلم» ثم سجّل الدخول.').waitFor(); await noSession(x);
});
await step(x.page, 'the parent sign-in is unchanged: a student account opens the student app with the old notice', async () => {
  await choose(x, 'ولي أمر'); await signIn(x, 'yousef@halqa.app');
  await x.app.getByText('السلام عليكم، يوسف').waitFor();
  await x.page.getByText('هذا ليس حساب ولي أمر', { exact: false }).waitFor();
});
await x.ctx.close();

x = await open(390, '#/teacher');
await step(x.page, '`#/teacher` link opens the teacher sign-in', async () => {
  await x.app.getByRole('heading', { name: 'تسجيل دخول المعلم' }).waitFor();
  if (new URL(x.page.url()).hash) throw new Error('hash kept');
});
await x.ctx.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
