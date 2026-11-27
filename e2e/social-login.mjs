// Social sign-in (owner request 27 Nov 2026) through the real app, API and PostgreSQL, with the development stand-in
// identity provider (AUTH_OAUTH_FAKE; it signs real ID tokens, so the server's state, browser binding, code exchange
// and ID-token checks all run). Real Google / Apple / Microsoft need their credentials and a real device (docs/AUTH.md).
//   node e2e/social-login.mjs <shots> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { pickWho } from './lib/who.mjs';
import { messages } from './lib/mailbox.mjs';
import { execSync } from 'node:child_process';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0; const errs = [];
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0].slice(0, 300)); await p.screenshot({ path: `${out}/social-fail-${name.replace(/\W+/g, '_')}.png`, fullPage: true }); } };
const sql = (q) => execSync(`psql "${process.env.DATABASE_URL}" -At -c "${q}"`).toString().trim();
const STAMP = Date.now().toString(36);

async function fresh() {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
  const page = await ctx.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', (e) => errs.push(e.message));
  const app = page.locator('main#scr');
  await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.locator('#lg-email').waitFor();
  return { ctx, page, app };
}
/** The provider's page: who signs in (`sub`), their email and whether the provider verified it. */
async function consent(page, { sub, email, name = 'مستخدم تجريبي', verified = true }) {
  await page.waitForURL(/oauth\/fake\/authorize/);
  await page.locator('input[name=sub]').fill(sub); await page.locator('input[name=email]').fill(email); await page.locator('input[name=name]').fill(name);
  const box = page.locator('input[name=email_verified]'); if ((await box.isChecked()) !== verified) await box.click();
  await page.getByRole('button', { name: 'متابعة' }).click();
}
const viaProvider = async (S, who) => { await S.page.getByRole('button', { name: 'المتابعة باستخدام التجريبي' }).click(); await consent(S.page, who); };

const NEW = { sub: `new-${STAMP}`, email: `omar-${STAMP}@example.test`, name: 'عمر خالد' };
const A = await fresh();
await step(A.page, '1. the sign-in screen keeps email and password and adds the provider buttons', async () => {
  await A.app.locator('#lg-pw').waitFor();
  await A.app.getByTestId('social-buttons').getByRole('button', { name: 'المتابعة باستخدام التجريبي' }).waitFor();
  await A.page.screenshot({ path: out + '/social-login.png' });
});
await step(A.page, '2. a new person registers with the provider: chooses «طالب», then the usual onboarding', async () => {
  await viaProvider(A, NEW);
  const f = A.page.getByRole('form', { name: 'إكمال إنشاء الحساب' });
  await f.getByText('أكمل إنشاء حسابك').waitFor();
  if ((await f.getByLabel('الاسم الكامل').inputValue()) !== 'عمر خالد') throw new Error('name not prefilled');
  await f.getByRole('button', { name: 'إنشاء الحساب' }).click(); await f.getByText('اختر نوع الحساب.').waitFor();   // the role is required
  await f.getByRole('radio', { name: /^طالب/ }).click(); await f.getByRole('radio', { name: 'ذكر' }).click();
  await f.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await A.page.locator('main#scr').getByText('مستواك', { exact: false }).first().waitFor({ timeout: 20000 });   // onboarding
  const row = sql(`select u.role || '|' || (u.password like '!%') || '|' || i.provider from accounts_user u join accounts_auth_identity i on i.user_id = u.id where u.email = '${NEW.email}'`);
  if (row !== 'student|true|fake') throw new Error('account ' + row);
});
await A.ctx.close();

const B = await fresh();
await step(B.page, '3. signing in again with the same provider account opens the same account (no duplicate)', async () => {
  await viaProvider(B, NEW);
  await B.page.locator('main#scr').getByText('السلام عليكم، عمر', { exact: false }).waitFor({ timeout: 20000 });
  if (sql(`select count(*) from accounts_user where email = '${NEW.email}'`) !== '1') throw new Error('duplicate');
});
await step(B.page, '4. «طرق تسجيل الدخول»: the only way in cannot be disconnected; this device is listed', async () => {
  await B.page.goto(BASE + '#/account').catch(() => {});
  await B.page.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  const box = B.app.getByTestId('sign-in-methods');
  await box.getByText('طرق تسجيل الدخول').waitFor();
  if (!(await box.getByRole('button', { name: 'فصل' }).isDisabled())) throw new Error('last way in can be removed');
  await box.getByText('هذا الجهاز', { exact: false }).waitFor();
  await B.page.screenshot({ path: out + '/social-methods.png', fullPage: true });
});
await B.ctx.close();

const Y = await fresh();
await step(Y.page, '5. an existing password account connects the provider from «حسابي»; data and role stay', async () => {
  await pickWho(Y.app, 'yousef@halqa.app'); await Y.app.locator('#lg-email').fill('yousef@halqa.app'); await Y.app.locator('#lg-pw').fill('halqa123');
  await Y.app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await Y.app.getByText('السلام عليكم، يوسف').waitFor();
  await Y.page.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  const box = Y.app.getByTestId('sign-in-methods');
  await box.getByRole('button', { name: 'ربط' }).click();
  await consent(Y.page, { sub: `y-${STAMP}`, email: 'yousef.personal@example.test' });
  await Y.page.getByText('تم ربط التجريبي بحسابك.').waitFor({ timeout: 20000 });
  await Y.app.getByTestId('sign-in-methods').getByText('مرتبط', { exact: false }).first().waitFor();
});
await Y.ctx.close();

const Y2 = await fresh();
await step(Y2.page, '6. then signing in with that provider opens Yousef\'s own account', async () => {
  await viaProvider(Y2, { sub: `y-${STAMP}`, email: 'yousef.personal@example.test' });
  await Y2.page.locator('main#scr').getByText('السلام عليكم، يوسف').waitFor({ timeout: 20000 });
  if (sql("select count(*) from accounts_user where email like 'yousef%'") !== '1') throw new Error('a second account was created');
});

const S = await fresh();
await step(S.page, '7. an email that already has an account is never merged automatically: a confirmation is emailed', async () => {
  const before = messages().length;
  await viaProvider(S, { sub: `sara-${STAMP}`, email: 'sara@halqa.app' });
  await S.page.getByTestId('oauth-message').getByText('لا نربط الحسابات تلقائيًا', { exact: false }).waitFor();
  if (sql(`select count(*) from accounts_auth_identity where subject = 'sara-${STAMP}'`) !== '0') throw new Error('linked without confirmation');
  const m = messages().slice(before).find((x) => x.to.includes('sara@halqa.app'));
  const link = /#\/oauth\?confirm=\S+/.exec(m?.text ?? '')?.[0];
  if (!link) throw new Error('no confirmation email');
  await S.page.goto(BASE + link);                                                 // proof of the mailbox: connects and signs in
  await S.page.locator('main#scr').getByText('السلام عليكم، سارة').waitFor({ timeout: 20000 });
});
await step(S.page, '8. an unverified provider email opens nothing', async () => {
  const U = await fresh();
  await viaProvider(U, { sub: `u-${STAMP}`, email: `u-${STAMP}@example.test`, verified: false });
  await U.page.getByTestId('oauth-message').getByText('لا يؤكد بريده', { exact: false }).waitFor();
  if (sql(`select count(*) from accounts_user where email = 'u-${STAMP}@example.test'`) !== '0') throw new Error('account created');
  await U.ctx.close();
});
await step(Y2.page, '9. «تسجيل الخروج من الأجهزة الأخرى» signs the other device out', async () => {
  const other = await fresh();
  await viaProvider(other, { sub: `y-${STAMP}`, email: 'yousef.personal@example.test' });
  await other.page.locator('main#scr').getByText('السلام عليكم، يوسف').waitFor({ timeout: 20000 });
  await Y2.page.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  const box = Y2.app.getByTestId('sign-in-methods');
  await box.getByRole('button', { name: 'تسجيل الخروج من الأجهزة الأخرى' }).click();
  await Y2.page.getByRole('dialog').getByRole('button', { name: 'تسجيل الخروج' }).click();
  await Y2.page.getByText('سُجّل الخروج من الأجهزة الأخرى').waitFor();
  const st = await other.page.evaluate(async () => (await fetch('/api/v1/me', { credentials: 'include' })).status);
  if (st !== 401 && st !== 403) throw new Error('other device still signed in: ' + st);
  const me = await Y2.page.evaluate(async () => (await fetch('/api/v1/me', { credentials: 'include' })).status);
  if (me !== 200) throw new Error('this device was signed out');
  await other.ctx.close();
});
await step(Y2.page, '10. no browser errors', async () => { if (errs.length) throw new Error(errs.slice(0, 3).join(' | ')); });
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
