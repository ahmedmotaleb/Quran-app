// Permanent account deletion as production runs it (fix of 24 Oct): the admin portal with two-step verification
// enforced, every delete confirmed with a reason, the typed word «حذف» and a CURRENT authenticator code.
// Checks the request carries the code, the specific errors, removed vs anonymized results, the teacher choice for
// upcoming sessions, immediate removal from the list (no reload) and that deleted accounts cannot sign in.
//   SETUP_CMD="bash e2e/ci/py.sh delete_setup.py" node e2e/account-delete.mjs <shots> http://localhost:5176/
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5176/').replace(/\/?$/, '/');
if (process.env.SETUP_CMD) execSync(process.env.SETUP_CMD, { stdio: 'inherit' });
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
function totp(secret, t = Date.now()) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) bits += alpha.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((x) => parseInt(x, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = createHmac('sha1', key).update(msg).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await b.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo' }); page.setDefaultTimeout(12000);
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0].slice(0, 300)); await page.screenshot({ path: `${out}/delete-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const dialog = () => page.getByRole('dialog').last();
const nav = (name) => page.getByRole('navigation', { name: 'التنقل في لوحة الإدارة' }).getByRole('button', { name }).click();
const canSignIn = async (email) => (await page.request.post(BASE + 'api/v1/auth/login', { data: { email, password: 'halqa123', client: 'native' } })).ok();
// The delete request: must carry a 6-digit code (the test fails if the portal ever drops it).
const deleteCall = () => page.waitForRequest((r) => r.url().includes('/users/bulk-action') && r.method() === 'POST');
const checkOtp = (req) => { const d = req.postDataJSON(); if (!/^\d{6}$/.test(d.otp ?? '')) throw new Error('no authenticator code in the delete request'); return d; };

await step('admin signs in with password and authenticator code (MFA enforced)', async () => {
  await page.goto(BASE + '#/admin');
  await page.locator('#ad-email').fill('admin@halqa.app'); await page.locator('#ad-pw').fill('halqa123');
  await page.getByRole('button', { name: 'دخول' }).click();
  await page.locator('#ad-otp').fill(totp(SECRET)); await page.getByRole('button', { name: 'تحقق ودخول' }).click();
  await page.getByText(/بيانات حقيقية/).waitFor();
  await nav(/^الطلاب/); await page.getByRole('button', { name: 'يوسف أحمد', exact: true }).waitFor();
});

await step('student with history: code required, wrong code explained, right code anonymizes; gone at once', async () => {
  if (!(await canSignIn('yousef@halqa.app'))) throw new Error('yousef cannot sign in before deletion');
  await page.getByRole('button', { name: 'يوسف أحمد', exact: true }).click();
  await dialog().getByRole('button', { name: 'حذف نهائي' }).click();
  await dialog().getByText('تبقى سجلاته الأكاديمية').waitFor();  // the preflight said: history kept, anonymized
  await dialog().locator('#rs').fill('طلب حذف الحساب');
  await dialog().locator('#rs-c').fill('حذف');
  await dialog().getByRole('button', { name: 'حذف نهائي' }).click();
  await dialog().getByText('أدخل رمز التحقق المكوّن من 6 أرقام من تطبيق المصادقة.').waitFor();
  await dialog().locator('#fresh-otp').fill('000000');
  let req = deleteCall(); await dialog().getByRole('button', { name: 'حذف نهائي' }).click(); checkOtp(await req);
  await dialog().getByText('رمز التحقق غير صحيح. أدخل الرمز الحالي وحاول مرة أخرى.').waitFor();
  await dialog().locator('#fresh-otp').fill(totp(SECRET));
  req = deleteCall();
  const resp = page.waitForResponse((r) => r.url().includes('/users/bulk-action'));
  await dialog().getByRole('button', { name: 'حذف نهائي' }).click();
  checkOtp(await req);
  const r = await resp; const body = await r.json();
  if (r.status() !== 200 || body.success !== 1 || body.mode !== 'anonymized') throw new Error(`${r.status()} ${JSON.stringify(body)}`);
  await page.getByText('تم حذف البيانات الشخصية مع الاحتفاظ بالسجل الأكاديمي مجهول الهوية.').waitFor();
  await page.getByRole('button', { name: 'يوسف أحمد', exact: true }).waitFor({ state: 'detached' });  // no reload
  if (await canSignIn('yousef@halqa.app')) throw new Error('deleted student can still sign in');
});

await step('account without activity is removed completely', async () => {
  await page.getByRole('searchbox').first().fill('بلا نشاط');
  await page.getByRole('button', { name: 'طالب بلا نشاط', exact: true }).click();
  await dialog().getByRole('button', { name: 'حذف نهائي' }).click();
  await dialog().getByText('لا نشاط لهذا الحساب، فسيُحذف بالكامل.').waitFor();
  await dialog().locator('#rs').fill('حساب تجريبي'); await dialog().locator('#rs-c').fill('حذف');
  await dialog().locator('#fresh-otp').fill(totp(SECRET));
  const req = deleteCall(); const resp = page.waitForResponse((r) => r.url().includes('/users/bulk-action'));
  await dialog().getByRole('button', { name: 'حذف نهائي' }).click(); checkOtp(await req);
  const body = await (await resp).json();
  if (body.success !== 1 || body.mode !== 'removed') throw new Error(JSON.stringify(body));
  await page.getByText('تم حذف الحساب نهائيًا').first().waitFor();
  await page.getByRole('button', { name: 'طالب بلا نشاط', exact: true }).waitFor({ state: 'detached' });
  if (await canSignIn('e2e-fresh@example.com')) throw new Error('removed account can sign in');
  await page.getByRole('searchbox').first().fill('');
});

await step('teacher with upcoming sessions: explicit choice; cancel the operation changes nothing', async () => {
  await nav(/^المعلمون/);
  await page.getByRole('button', { name: 'الشيخ عبدالرحمن السالم', exact: true }).click();
  await dialog().getByRole('button', { name: 'حذف نهائي' }).click();
  await dialog().getByText(/لدى هذا المعلم \d+ جلسات قادمة\./).waitFor();
  await dialog().getByRole('button', { name: 'إلغاء العملية' }).click();
  await page.getByRole('dialog', { name: 'حذف المعلم' }).waitFor({ state: 'detached' });
  if (!(await canSignIn('teacher@halqa.app'))) throw new Error('teacher changed after «إلغاء العملية»');
});

await step('teacher: «إلغاء الجلسات القادمة ثم حذف الحساب» cancels them and deletes', async () => {
  await dialog().getByRole('button', { name: 'حذف نهائي' }).click();
  await dialog().getByRole('button', { name: 'إلغاء الجلسات القادمة ثم حذف الحساب' }).click();
  await dialog().getByText(/ستُلغى أولًا \d+ جلسة قادمة/).waitFor();
  await dialog().locator('#rs').fill('انتهى التعاقد'); await dialog().locator('#rs-c').fill('حذف');
  await dialog().locator('#fresh-otp').fill(totp(SECRET));
  const req = deleteCall(); const resp = page.waitForResponse((r) => r.url().includes('/users/bulk-action'));
  await dialog().getByRole('button', { name: 'حذف نهائي' }).click();
  const d = checkOtp(await req); if (d.params?.cancel_sessions !== true) throw new Error('cancel_sessions not sent');
  const body = await (await resp).json();
  if (body.success !== 1) throw new Error(JSON.stringify(body));
  await page.getByText('تم حذف الحساب نهائيًا').first().waitFor();
  await page.getByRole('button', { name: 'الشيخ عبدالرحمن السالم', exact: true }).waitFor({ state: 'detached' });
  if (await canSignIn('teacher@halqa.app')) throw new Error('deleted teacher can sign in');
});

await step('bulk «حذف نهائي» with code: per-record result «تم الحذف: 1»', async () => {
  await nav(/^الطلاب/);
  await page.getByRole('checkbox', { name: 'تحديد سارة أحمد' }).check();
  await page.getByRole('toolbar', { name: 'إجراءات على المحدد' }).getByRole('button', { name: 'حذف نهائي', exact: true }).click();
  await dialog().locator('#bk-r').fill('حساب مكرر'); await dialog().locator('#bk-c').fill('حذف');
  await dialog().locator('#bk-otp').fill(totp(SECRET));
  const req = deleteCall(); const resp = page.waitForResponse((r) => r.url().includes('/users/bulk-action'));
  await dialog().locator('button[type=submit]').click(); checkOtp(await req);
  const body = await (await resp).json();
  if (body.success !== 1) throw new Error('bulk delete ' + JSON.stringify(body));
  await page.getByRole('button', { name: 'سارة أحمد', exact: true }).waitFor({ state: 'detached' });
  if (await page.getByRole('toolbar', { name: 'إجراءات على المحدد' }).count()) throw new Error('selection not cleared');
});
await page.screenshot({ path: out + '/account-delete.png' });
if (errs.length) { fails++; console.log('FAIL page errors', errs[0]); } else console.log('no page errors');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
