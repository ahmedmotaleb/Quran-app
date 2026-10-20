// Parent login (pack prompt 34): a parent created by the admin and linked to two children sets a password through the
// one-time link, lands on the parent sign-in, signs in through «تسجيل دخول ولي الأمر», sees only their children (no
// recordings), the chosen child is remembered, and logout ends the session. A student using the parent entry is still
// routed by the server to the student app.
//   SETUP_CMD="bash e2e/ci/py.sh parent_setup.py" node e2e/parent-login.mjs <shots> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const SETUP_OUT = `${out}/parent-setup.txt`;
execSync(process.env.SETUP_CMD || 'bash e2e/ci/py.sh parent_setup.py', { stdio: 'inherit', env: { ...process.env, SETUP_OUT } });
const query = readFileSync(SETUP_OUT, 'utf8').trim();
const PW = 'Parent-pass-2026';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
const page = await ctx.newPage(); page.setDefaultTimeout(10000);
const app = page.locator('main#scr');
const audio = []; page.on('request', (r) => { if (/\/media\/|\.webm|\.m4a|\.mp3/.test(r.url())) audio.push(r.url()); });
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${out}/parent-login-fail-${name.replace(/\W+/g, '_')}.png` }); } };

await step('setup link sets the password once and leads to the parent sign-in', async () => {
  await page.goto(`${BASE}#/reset?${query}`);
  await page.locator('#sp-pw').fill(PW); await page.locator('#sp-pw2').fill(PW);
  await page.getByRole('button', { name: 'حفظ كلمة المرور' }).click();
  await page.getByText('تم تعيين كلمة المرور.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'الذهاب إلى تسجيل الدخول' }).click();
  await app.getByRole('heading', { name: 'تسجيل دخول ولي الأمر' }).waitFor({ timeout: 15000 });
  if (new URL(page.url()).hash) throw new Error('hash kept: ' + page.url());
});
await step('the link cannot be used again', async () => {
  const p2 = await ctx.newPage();
  await p2.goto(`${BASE}#/reset?${query}`);
  await p2.locator('#sp-pw').fill(PW + 'x'); await p2.locator('#sp-pw2').fill(PW + 'x');
  await p2.getByRole('button', { name: 'حفظ كلمة المرور' }).click();
  await p2.getByRole('alert').first().waitFor();
  if (await p2.getByText('تم تعيين كلمة المرور.', { exact: false }).count()) throw new Error('link reused');
  await p2.close();
});
await step('parent signs in and lands on the parent portal with both children', async () => {
  await app.locator('#lg-email').fill('new.parent@halqa.app'); await app.locator('#lg-pw').fill(PW);
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByRole('heading', { name: 'متابعة الأبناء' }).waitFor();
  await app.getByRole('tab', { name: /يوسف/ }).waitFor(); await app.getByRole('tab', { name: /سارة/ }).waitFor();
});
await page.screenshot({ path: out + '/parent-login-home.png' });
await step('the chosen child is remembered after reopening the app', async () => {
  await app.getByRole('tab', { name: /سارة/ }).click();
  await page.reload();
  await app.getByRole('tab', { name: /سارة/, selected: true }).waitFor();
});
await step('no recording was requested', async () => { if (audio.length) throw new Error('requested ' + audio[0]); });
await step('logout ends the session and returns to the parent sign-in', async () => {
  await app.getByRole('button', { name: 'حسابي' }).click();
  await app.getByRole('button', { name: 'تسجيل الخروج' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'تسجيل الخروج' }).click();
  await app.getByRole('heading', { name: 'تسجيل دخول ولي الأمر' }).waitFor();
  const me = await page.evaluate(async () => (await fetch('/api/v1/me', { credentials: 'include' })).status);
  if (me !== 401 && me !== 403) throw new Error('me after logout: ' + me);
  await page.reload();
  await app.getByRole('heading', { name: 'تسجيل دخول ولي الأمر' }).or(app.getByRole('button', { name: 'تخطَّ' })).first().waitFor();
});
await step('a student using the parent entry still gets the student app (role from the server)', async () => {
  await page.goto(`${BASE}#/parent`);
  await app.getByRole('heading', { name: 'تسجيل دخول ولي الأمر' }).waitFor({ timeout: 15000 });
  await app.locator('#lg-email').fill('yousef@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText('السلام عليكم، يوسف').waitFor();
  await page.getByText('هذا ليس حساب ولي أمر', { exact: false }).waitFor();
});
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
