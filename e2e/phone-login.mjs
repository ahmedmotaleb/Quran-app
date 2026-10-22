// Sign in with email OR a verified phone number (owner request, 23 Oct 2026), against a seeded dev server whose SMS
// provider writes to SMS_FILE_PATH: node e2e/phone-login.mjs <shots-dir> [base-url]
// The student verifies a number from «حسابي» (code by SMS), signs out, signs in with the local number; a wrong
// password and an unverified number get the same generic answer; the email still works.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { readFileSync } from 'node:fs';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const SMS = process.env.SMS_FILE_PATH || '/tmp/halqa-sms.jsonl';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await b.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' }); page.setDefaultTimeout(10000);
const app = page.locator('main#scr');
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0].replace(/\u001b\[[0-9;]*m/g, '').slice(0, 300)); await page.screenshot({ path: `${out}/phone-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const GENERIC = 'البريد أو رقم الهاتف أو كلمة المرور غير صحيحة.';
const NUMBER = `010${String(Date.now()).slice(-8)}`; // a fresh valid Egyptian mobile number per run
const lastCode = (to) => {
  const m = readFileSync(SMS, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.to === to).at(-1);
  return /(\d{6})/.exec(m?.body ?? '')?.[1];
};
const signIn = async (ident, pw = 'halqa123') => {
  await app.locator('#lg-email').fill(ident); await app.locator('#lg-pw').fill(pw);
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
};
const signOut = async () => {
  await page.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  await app.getByRole('button', { name: /تسجيل الخروج/ }).click();
  await page.getByRole('button', { name: /تسجيل الخروج/ }).last().click().catch(() => {});
  await app.locator('#lg-email').waitFor();
};

await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
await step('the sign-in field accepts an email or a phone number', async () => {
  await app.getByText('البريد الإلكتروني أو رقم الهاتف').waitFor();
  await signIn('yousef@halqa.app'); await app.getByText('السلام عليكم، يوسف').waitFor();
});
await step('verify a phone number from «حسابي» with the SMS code', async () => {
  await page.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  await app.getByRole('heading', { name: 'تأكيد رقم الهاتف' }).waitFor();
  await app.getByRole('button', { name: 'تأكيد رقم الهاتف' }).click();
  await app.locator('#ph-num').fill(NUMBER); await app.getByRole('button', { name: 'إرسال رمز التأكيد' }).click();
  await app.getByText(/أرسلنا رمزًا من 6 أرقام/).waitFor();
  await app.locator('#ph-code').fill('000000'); await app.getByRole('button', { exact: true, name: 'تأكيد' }).click();
  await app.getByText(/الرمز غير صحيح/).waitFor();
  const e164 = '+20' + NUMBER.slice(1);
  await app.locator('#ph-code').fill(lastCode(e164)); await app.getByRole('button', { exact: true, name: 'تأكيد' }).click();
  await app.getByText('رقمك المؤكد:').waitFor();
});
await step('sign in with the local number (no country code)', async () => {
  await signOut();
  await signIn(NUMBER.replace(/(\d{3})(\d{4})(\d{4})/, '$1 $2 $3')); await app.getByText('السلام عليكم، يوسف').waitFor();
});
await step('a wrong password and an unverified number get the same generic answer', async () => {
  await signOut();
  await signIn(NUMBER, 'wrong-password-1'); await app.getByText(GENERIC).waitFor();
  await signIn('01099999998'); await app.getByText(GENERIC).waitFor();
  await signIn('abc'); await app.getByText('اكتب بريدًا إلكترونيًا أو رقم هاتف صحيحًا').waitFor();
});
await step('the email still signs in', async () => {
  await signIn('yousef@halqa.app'); await app.getByText('السلام عليكم، يوسف').waitFor();
});
await page.screenshot({ path: out + '/phone-login.png' });
if (errs.length) { fails++; console.log('page errors:', errs); }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
