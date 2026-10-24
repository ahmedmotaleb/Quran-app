// Teacher + admin on the same account (owner request, 24 October 2026), end to end:
//  1. The owner grants «الشيخ عبدالرحمن السالم» admin access from «الإدارة والصلاحيات» (search, preset,
//     confirmation with the current authenticator code); the list shows «معلم + إدارة».
//  2. The teacher opens «لوحة الإدارة» from «حسابي», signs in to the portal (password + authenticator), sees the
//     portal, and returns with «العودة إلى حساب المعلم» to the teacher app, still signed in as the teacher.
//  3. The owner removes the admin access: the teacher's portal session ends, the admin login refuses the account,
//     and the teacher app keeps working without «لوحة الإدارة».
//   SETUP_CMD="bash e2e/ci/py.sh teacher_admin_setup.py" node e2e/teacher-admin.mjs <shots> [base-url]
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
if (process.env.SETUP_CMD) execSync(process.env.SETUP_CMD, { stdio: 'inherit' });
const OWNER = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; const TEACHER = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';
function totp(secret, t = Date.now()) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) bits += alpha.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((x) => parseInt(x, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = createHmac('sha1', key).update(msg).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0; const errs = [];
const ctx = async (w, h) => { const c = await b.newContext({ viewport: { width: w, height: h }, timezoneId: 'Africa/Cairo' }); const p = await c.newPage(); p.setDefaultTimeout(12000); p.on('pageerror', (e) => errs.push(e.message)); return p; };
const A = await ctx(1280, 900); const T = await ctx(390, 844);
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0].slice(0, 300)); await p.screenshot({ path: `${out}/teacher-admin-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const portalLogin = async (p, email, secret) => {
  await p.locator('#ad-email').fill(email); await p.locator('#ad-pw').fill('halqa123');
  await p.getByRole('button', { name: 'دخول' }).click();
  await p.locator('#ad-otp').fill(totp(secret)); await p.getByRole('button', { name: 'تحقق ودخول' }).click();
};
const row = () => A.getByRole('listitem').filter({ hasText: 'الشيخ عبدالرحمن السالم' });

await step(A, 'owner grants a teacher admin access (search, preset, confirm with code)', async () => {
  await A.goto(BASE + 'admin/'); await portalLogin(A, 'admin@halqa.app', OWNER);
  await A.getByText(/بيانات حقيقية/).waitFor();
  await A.getByRole('navigation', { name: 'التنقل في لوحة الإدارة' }).getByRole('button', { name: /^الإدارة والصلاحيات/ }).click();
  await A.getByRole('button', { name: 'منح صلاحيات إدارة لمعلم' }).click();
  const d = A.getByRole('dialog', { name: 'منح صلاحيات إدارة لمعلم' });
  await d.locator('#gt-q').fill('عبدالرحمن');
  await d.getByRole('option', { name: /الشيخ عبدالرحمن السالم/ }).click();
  await d.locator('#gt-p').selectOption('academic_manager');
  await d.getByRole('button', { name: 'متابعة' }).click();
  const c = A.getByRole('dialog', { name: 'منح صلاحيات إدارة' });
  await c.getByText('مع الاحتفاظ بحسابه كمعلم', { exact: false }).waitFor();
  await c.locator('#gt-otp').fill(totp(OWNER));
  await c.getByRole('button', { name: 'منح صلاحيات الإدارة' }).click();
  await A.getByRole('status').filter({ hasText: 'مع الاحتفاظ بحسابه كمعلم' }).waitFor();
  await row().getByText('معلم + إدارة').waitFor();
  await A.screenshot({ path: out + '/teacher-admin-granted.png' });
});

await step(T, 'teacher opens «لوحة الإدارة», signs in, and returns to the teacher account', async () => {
  await T.goto(BASE);
  const skip = T.getByRole('button', { exact: true, name: 'تخطَّ' }); await skip.or(T.locator('#lg-email')).first().waitFor();
  if (await skip.count()) await skip.click();
  await T.locator('#lg-email').fill('teacher@halqa.app'); await T.locator('#lg-pw').fill('halqa123');
  await T.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await T.getByText('مرحبًا، الشيخ عبدالرحمن السالم').waitFor();
  await T.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  await T.getByText('حساب معلم').waitFor();
  await T.getByRole('button', { name: /لوحة الإدارة/ }).click();
  await T.waitForURL(/\/admin\//);
  await portalLogin(T, 'teacher@halqa.app', TEACHER);
  await T.getByText(/الشيخ عبدالرحمن السالم · بيانات حقيقية/).waitFor({ timeout: 15000 }).catch(async () => {
    // narrow layout: the header badge may wrap; the excuses section is part of academic_manager
    await T.getByText('بيانات حقيقية', { exact: false }).first().waitFor();
  });
  await T.screenshot({ path: out + '/teacher-admin-portal.png' });
  const back = T.getByRole('button', { name: '← العودة إلى حساب المعلم' });
  if (!(await back.isVisible())) await T.getByRole('button', { name: /القائمة|فتح القائمة/ }).first().click();
  await back.click();
  await T.getByText('مرحبًا، الشيخ عبدالرحمن السالم').waitFor();
});

await step(A, 'owner removes admin access: the portal session ends, the teacher account stays', async () => {
  await row().getByRole('button', { name: /إزالة صلاحيات الإدارة/ }).click();
  const d = A.getByRole('dialog', { name: 'إزالة صلاحيات الإدارة' });
  await d.locator('#rs').fill('انتهت المهمة الإدارية');
  await d.locator('#fresh-otp').fill(totp(OWNER));
  await d.getByRole('button', { name: 'إزالة الصلاحيات' }).click();
  await A.getByRole('status').filter({ hasText: 'أُزيلت صلاحيات الإدارة' }).waitFor();
  await row().waitFor({ state: 'detached' });
  await T.goto(BASE + 'admin/');
  await T.locator('#ad-email').waitFor();                       // signed out of the portal
  await T.locator('#ad-email').fill('teacher@halqa.app'); await T.locator('#ad-pw').fill('halqa123');
  await T.getByRole('button', { name: 'دخول' }).click();
  await T.getByText('هذا الحساب لا يملك صلاحية الدخول إلى لوحة الإدارة.').waitFor();
  await T.goto(BASE);
  await T.getByText('مرحبًا، الشيخ عبدالرحمن السالم').waitFor();   // the teacher app session is untouched
  await T.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  await T.getByText('حساب معلم').waitFor();
  if (await T.getByRole('button', { name: /لوحة الإدارة/ }).count()) throw new Error('«لوحة الإدارة» still shown');
});

if (errs.length) { fails++; console.log('FAIL page errors', errs[0]); } else console.log('no page errors');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
