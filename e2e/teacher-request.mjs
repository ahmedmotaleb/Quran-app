// «اختر معلمك»: a student without a teacher searches and requests one (or suggests a name), sees «طلبك قيد المراجعة»,
// cannot send a second pending request; the admin reviews in «طلبات اختيار المعلم» and assigns; the card disappears
// and the student is notified. 390 px, RTL.   LONE_CMD="bash e2e/ci/py.sh lone_student.py" node e2e/teacher-request.mjs <shots> [base]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { execSync } from 'node:child_process';
import { pickWho } from './lib/who.mjs';
if (process.env.LONE_CMD) execSync(process.env.LONE_CMD, { stdio: 'inherit' });
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0].slice(0, 300)); await p.screenshot({ path: `${out}/treq-fail-${name.replace(/\W+/g, '_')}.png` }); } };
async function student(email) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
  const page = await ctx.newPage(); page.setDefaultTimeout(10000);
  const app = page.locator('main#scr');
  await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await pickWho(app, email); await app.locator('#lg-email').fill(email); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText('السلام عليكم').first().waitFor();
  return { ctx, page, app, card: app.getByTestId('choose-teacher') };
}

const L = await student('lone@halqa.app');
await step(L.page, 'a student without a teacher sees «اختر معلمك», searches by name and requests a teacher', async () => {
  await L.card.getByRole('heading', { name: 'اختر معلمك' }).waitFor();
  const list = L.card.getByRole('list', { name: 'المعلمون المتاحون' });
  await list.getByRole('listitem').first().waitFor();
  await L.card.getByRole('searchbox', { name: 'ابحث باسم المعلم' }).fill('خالد');
  if ((await list.getByRole('listitem').count()) !== 1) throw new Error('search did not narrow to one teacher');
  await list.getByRole('listitem').filter({ hasText: 'الشيخ خالد العمري' }).click();      // with the title
  await L.card.getByRole('button', { name: 'اطلب الشيخ خالد العمري' }).click();
  await L.page.getByText('أُرسل طلبك إلى الإدارة للمراجعة').waitFor();
  await L.card.getByRole('heading', { name: 'طلبك قيد المراجعة' }).waitFor();
  await L.card.getByText('بانتظار المراجعة', { exact: false }).waitFor();
  if (await L.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('sideways scroll');
  await L.page.screenshot({ path: out + '/treq-pending.png' });
});
await step(L.page, 'a second pending request is refused by the server', async () => {
  const r = await L.page.evaluate(async () => {
    const csrf = (await (await fetch('/api/v1/auth/csrf', { credentials: 'include' })).json()).csrfToken;
    return (await fetch('/api/v1/student/teacher-request', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf }, body: JSON.stringify({ suggested_name: 'معلم آخر' }) })).json();
  });
  if (r.code !== 'duplicate_request') throw new Error(JSON.stringify(r));
});

const L2 = await student('lone2@halqa.app');
await step(L2.page, 'a teacher not in the list can be suggested by name', async () => {
  await L2.card.getByText('لم تجد معلمك؟ اقترحه بالاسم').click();
  await L2.card.getByRole('textbox', { name: 'اسم المعلم المقترح' }).fill('الشيخ محمود الحصري');
  await L2.card.getByRole('button', { name: 'إرسال الاقتراح' }).click();
  await L2.card.getByRole('heading', { name: 'طلبك قيد المراجعة' }).waitFor();
  await L2.card.getByText('الشيخ محمود الحصري', { exact: false }).waitFor();
});
await step(L2.page, 'the dashboard reminder can be dismissed (hidden for 48 hours)', async () => {
  await L2.card.getByRole('button', { name: 'إخفاء «اختر معلمك» لمدة يومين' }).click();
  await L2.page.reload(); await L2.app.getByText('السلام عليكم').first().waitFor(); await L2.page.waitForTimeout(800);
  if (await L2.card.count()) throw new Error('shown again right after dismissing');
});

const actx = await b.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo' });
const A = await actx.newPage(); A.setDefaultTimeout(10000);
await step(A, 'admin reviews «طلبات اختيار المعلم» and assigns the requested teacher', async () => {
  await A.goto(BASE + '#/admin');
  await A.locator('#ad-email').fill('admin@halqa.app'); await A.locator('#ad-pw').fill('halqa123');
  await A.getByRole('button', { name: 'دخول' }).click(); await A.getByText(/بيانات حقيقية/).waitFor();
  await A.getByRole('navigation', { name: 'التنقل في لوحة الإدارة' }).getByRole('button', { name: /^طلبات اختيار المعلم/ }).click();
  const row = A.locator('[data-request]', { hasText: 'طالب بلا معلم' }).first();
  await row.getByText('الشيخ خالد العمري').waitFor(); await row.getByText('بانتظار المراجعة').waitFor();
  await A.locator('[data-request]', { hasText: 'الشيخ محمود الحصري' }).getByText('ليس في القائمة', { exact: false }).waitFor();
  await row.getByRole('button', { name: 'تعيين المعلم' }).click();
  const d = A.getByRole('dialog').last();
  await d.getByRole('combobox').selectOption({ label: 'الشيخ خالد العمري' }).catch(async () => {
    const v = await d.locator('option', { hasText: 'خالد العمري' }).getAttribute('value'); await d.getByRole('combobox').selectOption(v);
  });
  await d.getByRole('button', { name: 'تعيين المعلم' }).click();
  await A.getByText('عُيّن المعلم وأُبلغ الطالب').waitFor();
  await A.getByRole('tab', { name: 'تم تعيين المعلم' }).click();
  const done = A.locator('[data-request]', { hasText: 'طالب بلا معلم' }).first();
  await done.getByText('عُيّن: الشيخ خالد العمري').waitFor();
  await done.getByRole('button', { name: /سجل الإشعارات/ }).click();
  await done.getByText('تم تعيين معلمك', { exact: false }).waitFor();
  await A.screenshot({ path: out + '/treq-admin.png' });
});

await step(L.page, 'after assignment: the card is gone and the student was notified', async () => {
  await L.page.reload(); await L.app.getByText('السلام عليكم').first().waitFor(); await L.page.waitForTimeout(800);
  if (await L.card.count()) throw new Error('«اختر معلمك» still shown after assignment');
  await L.app.getByRole('button', { name: /الإشعارات/ }).first().click();
  await L.app.getByText('تم تعيين معلمك').first().waitFor();
});

const S = await student('yousef@halqa.app');
await step(S.page, 'a student who already has a teacher never sees «اختر معلمك»', async () => {
  await S.page.waitForTimeout(800);
  if (await S.card.count()) throw new Error('shown to a student with a teacher');
});
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
