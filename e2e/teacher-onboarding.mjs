// Teacher onboarding (owner request, 23 Oct 2026), against a seeded dev server with the file mailbox:
// node e2e/teacher-onboarding.mjs <shots-dir> [base-url]
// «إنشاء الحساب وإرسال رابط الإعداد» creates the teacher at once; the email link sets the password; the teacher
// signs in from the normal login and waits for approval; Forgot Password works for an ignored email; resend works.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { linkFor } from './lib/mailbox.mjs';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const admin = await b.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo' }); admin.setDefaultTimeout(10000);
const errs = []; admin.on('pageerror', (e) => errs.push(e.message));
let fails = 0;
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0].replace(/\u001b\[[0-9;]*m/g, '').slice(0, 300)); await p.screenshot({ path: `${out}/onboard-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const dialog = () => admin.getByRole('dialog').last();
const stamp = Date.now(); const PW = 'Teacher-Pass-2026';
const local = (link) => BASE + link.slice(link.indexOf('#'));

async function phone() {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
  const p = await ctx.newPage(); p.setDefaultTimeout(10000); p.on('pageerror', (e) => errs.push(e.message));
  return p;
}
async function setPassword(p, link) {
  await p.goto(local(link));
  await p.locator('#sp-pw').fill(PW); await p.locator('#sp-pw2').fill(PW);
  await p.getByRole('button', { name: 'حفظ كلمة المرور' }).click();
  await p.getByText('تم إعداد حسابك بنجاح').waitFor();
  await p.getByRole('button', { name: 'تسجيل الدخول' }).click();
}
async function signIn(p, email) {
  const app = p.locator('main#scr');
  await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click().catch(() => {});
  await app.locator('#lg-email').fill(email); await app.locator('#lg-pw').fill(PW);
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
}
async function createTeacher(name, email) {
  await admin.getByRole('button', { name: 'إضافة / دعوة معلم' }).click();
  await dialog().locator('#ad-n').fill(name); await dialog().locator('#ad-e').fill(email);
  await dialog().getByRole('button', { name: 'إنشاء الحساب وإرسال رابط الإعداد' }).click();
  await dialog().getByText(`تم إرسال رابط الإعداد إلى`).waitFor();
  await dialog().getByRole('button', { name: 'تم' }).click();
}

await admin.goto(BASE + '#/admin');
await admin.locator('#ad-email').fill('admin@halqa.app'); await admin.locator('#ad-pw').fill('halqa123');
await admin.getByRole('button', { name: 'دخول' }).click(); await admin.getByText(/بيانات حقيقية/).waitFor();
await admin.getByRole('navigation', { name: 'أقسام الإدارة' }).getByRole('button', { name: /^المعلمون/ }).click();

const T1 = `abdulrahman${stamp}@example.com`;
await step(admin, 'admin creates the teacher account and the setup email is sent', async () => {
  await createTeacher('عبدالرحمن', T1);
  await admin.getByRole('searchbox').first().fill(T1);
  await admin.getByText('لم يعيّن كلمة مرور · تم إرسال رابط الإعداد').first().waitFor();
  await admin.getByText('بانتظار الاعتماد').first().waitFor();
});
let t1 = null;
await step(admin, 'the email link sets the password; the teacher signs in from the normal login and waits for approval', async () => {
  const m = await linkFor(T1);
  if (m.subject !== 'إعداد حساب المعلم في حَلْقة' || !m.text.includes('تم إنشاء حساب معلم لك في منصة حَلْقة.') || !/#\/reset\?uid=/.test(m.link)) throw new Error('email');
  t1 = await phone(); await setPassword(t1, m.link); await signIn(t1, T1);
  await t1.getByText('مرحبًا، عبدالرحمن').waitFor();
  await t1.getByText(/بانتظار الاعتماد:/).waitFor();
});
await step(admin, 'the admin record shows setup done; approval removes the notice', async () => {
  await admin.reload(); await admin.getByRole('searchbox').first().fill(T1);
  await admin.getByRole('button', { name: 'عبدالرحمن' }).first().click();
  await dialog().getByText('تم إعداد الحساب').waitFor();
  await dialog().getByRole('button', { name: 'اعتماد المعلم' }).click();
  await dialog().getByText('معتمد', { exact: true }).first().waitFor();
  await dialog().getByRole('button', { name: 'إغلاق' }).click();
  await t1.reload(); await t1.getByText('مرحبًا، عبدالرحمن').waitFor(); await t1.waitForTimeout(800);
  if (await t1.getByText(/بانتظار الاعتماد:/).count()) throw new Error('still pending after approval');
});
const T2 = `lost${stamp}@example.com`;
await step(admin, 'a teacher who ignored the email uses «نسيت كلمة المرور؟»', async () => {
  await createTeacher('معلم ناسٍ', T2);
  const first = (await linkFor(T2)).link;
  const p = await phone(); await p.goto(BASE);
  const app = p.locator('main#scr');
  await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.getByRole('button', { name: 'نسيت كلمة المرور؟' }).click();
  await app.locator('#fg-email').fill(T2); await app.getByRole('button', { name: 'أرسل رابط الاستعادة' }).click();
  let fresh = first;
  for (let i = 0; i < 40 && fresh === first; i++) { await p.waitForTimeout(250); fresh = (await linkFor(T2)).link; }
  if (fresh === first) throw new Error('no fresh email');
  await setPassword(p, fresh); await signIn(p, T2); await p.getByText('مرحبًا، معلم ناسٍ').waitFor();
});
const T3 = `resend${stamp}@example.com`;
await step(admin, 'the admin resends the setup email from the record; the fresh link works', async () => {
  await createTeacher('معلم ثالث', T3);
  const first = (await linkFor(T3)).link;
  await admin.getByRole('searchbox').first().fill(T3);
  await admin.getByRole('button', { name: 'معلم ثالث' }).first().click();
  await dialog().getByText('لم يُكمل إعداد الحساب', { exact: false }).waitFor();
  await admin.waitForTimeout(31000); // the server refuses a second email within 30 seconds
  await dialog().getByRole('button', { name: 'إعادة إرسال رابط إعداد الحساب' }).click();
  await dialog().getByText(`تم إرسال رابط الإعداد إلى ${T3}`).waitFor();
  await dialog().getByText(/عدد مرات الإرسال: 2/).waitFor();
  const fresh = (await linkFor(T3)).link;
  if (fresh === first) throw new Error('no fresh link');
  const p = await phone(); await setPassword(p, fresh); await signIn(p, T3); await p.getByText('مرحبًا، معلم ثالث').waitFor();
});
await admin.screenshot({ path: out + '/teacher-onboarding.png', fullPage: true });
if (errs.length) { fails++; console.log('page errors:', errs); }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
