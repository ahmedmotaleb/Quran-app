// Live admin portal sign-in (pack prompt 04): real backend auth, refusals, session restore, two-step setup,
// sign-in with a code, sign-out. Run against a seeded dev server like e2e/live.mjs:
//   node e2e/admin.mjs <shots-dir> [base-url]
// Turns on two-step verification for admin@halqa.app; pass RESET_CMD to turn it off again afterwards.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const ADMIN = BASE + '#/admin';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await b.newPage({ viewport: { width: 1280, height: 860 }, timezoneId: 'Africa/Cairo' }); page.setDefaultTimeout(10000);
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${out}/admin-fail-${name.replace(/\W+/g, '_')}.png` }); } };

// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from a base32 secret.
function totp(secret, t = Date.now()) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) bits += alpha.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((x) => parseInt(x, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = createHmac('sha1', key).update(msg).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
const signIn = async (email, pw) => {
  await page.locator('#ad-email').fill(email); await page.locator('#ad-pw').fill(pw);
  await page.getByRole('button', { name: /^(دخول|تحقق ودخول)$/ }).click();
};

await page.goto(ADMIN);
await step('demo credentials hint is gone in live mode', async () => {
  await page.locator('#ad-email').waitFor();
  if (await page.getByText('حساب تجريبي').count()) throw new Error('demo hint shown');
});
await step('wrong password is refused', async () => {
  await signIn('admin@halqa.app', 'wrong-password-1');
  await page.getByText('البريد أو رقم الهاتف أو كلمة المرور غير صحيحة.').waitFor();
});
await step('a student account is refused', async () => {
  await signIn('yousef@halqa.app', 'halqa123');
  await page.getByText('هذا الحساب لا يملك صلاحيات الإدارة.').waitFor();
});
await step('admin signs in and sees their name', async () => {
  await signIn('admin@halqa.app', 'halqa123');
  await page.getByText(/مدير المنصة · بيانات حقيقية/).waitFor();
});
await step('refresh keeps the session', async () => {
  await page.reload(); await page.getByText(/مدير المنصة · بيانات حقيقية/).waitFor();
});
if (process.env.MFA_ENFORCED) await step('sections stay locked until two-step verification is on', async () => {
  await page.getByText('تُفتح أقسام الإدارة بعد تفعيل التحقق بخطوتين.').waitFor();
});
let secret = '';
await step('turn on two-step verification', async () => {
  await page.getByRole('button', { name: 'ابدأ التفعيل' }).click();
  secret = (await page.locator('code').innerText()).trim();
  await page.locator('#mfa-otp').fill('000000'); await page.getByRole('button', { name: 'تأكيد التفعيل' }).click();
  await page.getByText('رمز التحقق غير صحيح.').waitFor();
  await page.locator('#mfa-otp').fill(totp(secret)); await page.getByRole('button', { name: 'تأكيد التفعيل' }).click();
  await page.getByRole('heading', { name: 'فعّل التحقق بخطوتين' }).waitFor({ state: 'detached' });
  if (await page.getByText('تُفتح أقسام الإدارة بعد تفعيل التحقق بخطوتين.').count()) throw new Error('still locked');
});
await page.screenshot({ path: out + '/admin-portal.png' });
await step('sign out clears the portal; refresh stays signed out', async () => {
  await page.getByRole('button', { name: /تسجيل الخروج/ }).first().click();
  await page.locator('#ad-email').waitFor(); await page.reload(); await page.locator('#ad-email').waitFor();
});
await step('sign-in now asks for the code, refuses a wrong one, accepts the right one', async () => {
  await signIn('admin@halqa.app', 'halqa123');
  await page.locator('#ad-otp').waitFor();
  await page.locator('#ad-otp').fill('000000'); await page.getByRole('button', { name: 'تحقق ودخول' }).click();
  await page.getByText('رمز التحقق غير صحيح.').waitFor();
  await page.locator('#ad-otp').fill(totp(secret)); await page.getByRole('button', { name: 'تحقق ودخول' }).click();
  await page.getByText(/مدير المنصة · بيانات حقيقية/).waitFor();
});
await page.screenshot({ path: out + '/admin-mfa-signed-in.png' });
await step('«تذكّر هذا الجهاز» (ticked by default): next sign-in asks only for the password', async () => {
  await page.getByRole('button', { name: /تسجيل الخروج/ }).first().click(); await page.locator('#ad-email').waitFor();
  await signIn('admin@halqa.app', 'halqa123');
  await page.getByText(/مدير المنصة · بيانات حقيقية/).waitFor();
  if (await page.locator('#ad-otp').count()) throw new Error('code asked on a trusted device');
});
await step('Settings lists the trusted device; removing it brings the code back', async () => {
  await page.getByRole('navigation', { name: 'أقسام الإدارة' }).getByRole('button', { name: /^الإعدادات/ }).click();
  await page.getByText('(هذا الجهاز)').waitFor();
  await page.getByRole('button', { name: 'إزالة كل الأجهزة' }).click();
  await page.getByText('لا توجد أجهزة موثوقة.', { exact: false }).waitFor();
  await page.getByRole('button', { name: /تسجيل الخروج/ }).first().click(); await page.locator('#ad-email').waitFor();
  await signIn('admin@halqa.app', 'halqa123');
  await page.locator('#ad-otp').waitFor();
  await page.getByText('تذكّر هذا الجهاز', { exact: false }).waitFor();
});
if (process.env.RESET_CMD) execSync(process.env.RESET_CMD, { stdio: 'inherit' });
if (errs.length) { fails++; console.log('page errors:', errs); }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
