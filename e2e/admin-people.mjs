// Live admin portal: students, teachers and parents persist through the API (pack prompt 05).
// Run against a freshly seeded dev server (see e2e/admin.mjs): node e2e/admin-people.mjs <shots-dir> [base-url]
// Every check that matters reloads the page first, so it reads what the server stored, not local state.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { trackWrites } from './lib/settle.mjs';
import { linkFor } from './lib/mailbox.mjs';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo', permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage(); page.setDefaultTimeout(10000);
const { settledReload } = trackWrites(page);
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${out}/people-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const nav = (name) => page.getByRole('navigation', { name: 'التنقل في لوحة الإدارة' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
const dialog = () => page.getByRole('dialog').last();
const openPerson = async (name) => { await page.getByRole('button', { name, exact: true }).click(); await dialog().getByText('حالة الحساب').waitFor(); };
const reopen = async (section, name) => { await settledReload(); await nav(section); await openPerson(name); };
const stamp = Date.now();
const SN = `طالب الاختبار ${stamp % 100000}`; const SN2 = `${SN} المعدّل`; const TN = `معلم الاختبار ${stamp % 100000}`;

await page.goto(BASE + '#/admin');
await page.locator('#ad-email').fill('admin@halqa.app'); await page.locator('#ad-pw').fill('halqa123');
await page.getByRole('button', { name: 'دخول' }).click();
await page.getByText(/بيانات حقيقية/).waitFor();

await step('overview shows real counts', async () => {
  await page.getByText('طلاب نشطون').waitFor();
  // No payments yet (owner decision): no Subscriptions section or demo note in the live portal.
  if (await page.getByRole('navigation').getByRole('button', { name: 'الاشتراكات' }).count()) throw new Error('Subscriptions still in the menu');
  if (await page.getByText(/بيانات عرض تجريبية/).count()) throw new Error('demo-data note still shown');
});
await step('students list comes from the server', async () => {
  await nav('الطلاب'); await page.getByRole('button', { name: 'يوسف أحمد', exact: true }).waitFor();
  await page.getByRole('button', { name: 'سارة أحمد', exact: true }).waitFor();
  if (await page.getByText('هذا القسم ما زال ببيانات عرض تجريبية').count()) throw new Error('demo badge on a live section');
});
await step('search filters on the server', async () => {
  await page.getByRole('searchbox', { name: 'ابحث بالاسم أو البريد' }).fill('سارة');
  await page.getByRole('button', { name: 'يوسف أحمد', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('searchbox', { name: 'ابحث بالاسم أو البريد' }).fill('');
});
let setupLink = '';
await step('add a student: the setup link is emailed (nothing to copy)', async () => {
  await page.getByRole('button', { name: 'إضافة طالب' }).click();
  await dialog().locator('#ad-n').fill(SN); await dialog().locator('#ad-e').fill(`e2e+${stamp}@example.com`);
  await dialog().getByRole('button', { name: 'إنشاء الحساب وإرسال رابط الإعداد' }).click();
  await dialog().getByText('تم إرسال رابط الإعداد إلى', { exact: false }).waitFor();
  if (await dialog().locator('code').count()) throw new Error('a raw link is shown');
  const m = await linkFor(`e2e+${stamp}@example.com`);
  setupLink = m.link;
  if (!setupLink.includes('#/reset?uid=')) throw new Error('no setup link in the email');
  await dialog().getByRole('button', { name: 'تم' }).click();
  await settledReload(); await nav('الطلاب'); await page.getByRole('button', { name: SN, exact: true }).waitFor();
});
await step('the new student sets a password from the link and signs in', async () => {
  const p2 = await ctx.newPage(); await p2.goto(setupLink.replace(/^https?:\/\/[^/]+\//, BASE));
  await p2.locator('#sp-pw').fill('E2e-Student-2026!'); await p2.locator('#sp-pw2').fill('E2e-Student-2026!');
  await p2.getByRole('button', { name: 'حفظ كلمة المرور' }).click();
  await p2.getByText('تم إعداد حسابك بنجاح').waitFor();
  const r = await p2.request.post(BASE + 'api/v1/auth/login', { data: { email: `e2e+${stamp}@example.com`, password: 'E2e-Student-2026!', client: 'native' } });
  if (r.status() !== 200) throw new Error(`login ${r.status()}`);
  await p2.close();
});
await step('edit a profile; it persists after reload', async () => {
  await openPerson(SN);
  await dialog().getByRole('button', { name: 'تعديل البيانات' }).click();
  await dialog().locator('#ed-n').fill(SN2); await dialog().locator('#ed-p').fill('+201001234567');
  await dialog().getByRole('button', { name: 'حفظ' }).click();
  await reopen('الطلاب', SN2); await dialog().getByText('+201001234567').waitFor();
});
await step('suspend needs a reason; reactivate; both persist', async () => {
  await dialog().getByRole('button', { name: 'إيقاف الحساب' }).click();
  await dialog().getByRole('button', { name: 'إيقاف الحساب' }).click();
  await dialog().getByText('اكتب السبب (3 أحرف على الأقل).').waitFor();
  await dialog().locator('#rs').fill('اختبار الإيقاف'); await dialog().getByRole('button', { name: 'إيقاف الحساب' }).click();
  await reopen('الطلاب', SN2); await dialog().getByText('سبب الحالة: اختبار الإيقاف', { exact: false }).waitFor();
  await dialog().getByRole('button', { name: 'إعادة التفعيل' }).click();
  await dialog().locator('#rs').fill('تمت مراجعة حالة الطالب'); await dialog().getByRole('button', { name: 'إعادة التفعيل' }).click();
  await reopen('الطلاب', SN2); await dialog().getByRole('button', { name: 'إيقاف الحساب' }).waitFor();
});
await step('link the student to a teacher and a parent; both persist', async () => {
  await dialog().getByRole('button', { name: 'ربط بمعلم' }).click();
  await dialog().getByRole('button', { name: /الشيخ خالد العمري/ }).click();
  await dialog().getByText('الشيخ خالد العمري').waitFor();
  await dialog().getByRole('button', { name: 'ربط بولي أمر' }).click();
  await dialog().getByRole('button', { name: /أحمد العلي/ }).click();
  await reopen('الطلاب', SN2);
  await dialog().getByText('الشيخ خالد العمري').waitFor(); await dialog().getByText('أحمد العلي').waitFor();
});
await step('the parent sees the new child; unlink from the parent side persists', async () => {
  await page.keyboard.press('Escape'); await nav('أولياء الأمور'); await openPerson('أحمد العلي');
  await dialog().getByText(SN2).waitFor();
  await dialog().getByRole('button', { name: `فك ربط ${SN2}` }).click();
  await dialog().locator('#rs').fill('اختبار فك الربط'); await dialog().getByRole('button', { name: 'فك الربط' }).click();
  await reopen('أولياء الأمور', 'أحمد العلي');
  if (await dialog().getByText(SN2).count()) throw new Error('child still linked');
});
await step('withdraw and restore a teacher approval', async () => {
  await page.keyboard.press('Escape'); await nav('المعلمون'); await openPerson('الشيخ خالد العمري');
  await dialog().getByRole('button', { name: 'سحب الاعتماد' }).click();
  await dialog().locator('#rs').fill('مراجعة الملف'); await dialog().getByRole('button', { name: 'سحب الاعتماد' }).click();
  await reopen('المعلمون', 'الشيخ خالد العمري'); await dialog().getByRole('button', { name: 'اعتماد المعلم' }).click();
  await reopen('المعلمون', 'الشيخ خالد العمري'); await dialog().getByRole('button', { name: 'سحب الاعتماد' }).waitFor();
});
await step('link a parent who has no account yet: search by email → create the parent and link', async () => {
  await reopen('الطلاب', SN2);
  await dialog().getByRole('button', { name: 'ربط بولي أمر' }).click();
  await dialog().getByRole('searchbox', { name: 'بحث' }).fill(`dad+${stamp}@example.com`);
  await dialog().locator('#pk-n').fill('محمود والد الطالب');
  const linked = page.waitForResponse((r) => r.request().method() === 'POST' && /guardian|link/.test(r.url()) && !r.url().includes('admin/users?'));
  await dialog().getByRole('button', { name: 'إنشاء حساب ولي الأمر وربطه' }).click();
  const lr = await linked; if (!lr.ok()) throw new Error('link ' + lr.status() + ' ' + (await lr.text()).slice(0, 200));
  await page.getByRole('dialog', { name: 'اختر ولي الأمر' }).waitFor({ state: 'detached' });
  await reopen('الطلاب', SN2); await dialog().getByText('محمود والد الطالب').waitFor({ timeout: 15000 });
});
let invite = '';
await step('create a teacher: account now, setup email, password from the link, then approval', async () => {
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await nav('المعلمون');
  await page.getByRole('button', { name: 'إضافة / دعوة معلم' }).click();
  await dialog().locator('#ad-n').fill(TN); await dialog().locator('#ad-e').fill(`teach+${stamp}@example.com`);
  await dialog().getByRole('button', { name: 'إنشاء الحساب وإرسال رابط الإعداد' }).click();
  await dialog().getByText(`تم إرسال رابط الإعداد إلى`, { exact: false }).waitFor();
  if (await dialog().locator('code').count()) throw new Error('a raw link is shown');
  const m = await linkFor(`teach+${stamp}@example.com`);
  invite = m.link; if (!invite.includes('#/reset?uid=')) throw new Error('setup link ' + invite);
  await dialog().getByRole('button', { name: 'تم' }).click();
  const c3 = await b.newContext(); const p3 = await c3.newPage(); await p3.goto(invite.replace(/^https?:\/\/[^/]+\//, BASE));
  await p3.locator('#sp-pw').fill('E2e-Teacher-2026!'); await p3.locator('#sp-pw2').fill('E2e-Teacher-2026!');
  await p3.getByRole('button', { name: 'حفظ كلمة المرور' }).click(); await p3.getByText('تم إعداد حسابك بنجاح').waitFor(); await c3.close();
  await settledReload(); await nav('المعلمون'); await openPerson(TN);
  await dialog().getByRole('button', { name: 'اعتماد المعلم' }).click();  // account setup ≠ approval
  await dialog().getByRole('button', { name: 'سحب الاعتماد' }).waitFor();
});
await page.screenshot({ path: out + '/people-teacher.png' });
await step('a student email in «دعوة معلم»: no new account; «ترقية إلى معلم» keeps the same account', async () => {
  await page.keyboard.press('Escape'); await nav('المعلمون');
  await page.getByRole('button', { name: 'إضافة / دعوة معلم' }).click();
  await dialog().locator('#ad-n').fill('معلم تجريبي'); await dialog().locator('#ad-e').fill('admin@halqa.app');
  await dialog().getByRole('button', { name: 'إنشاء الحساب وإرسال رابط الإعداد' }).click();
  await dialog().getByText('هذا البريد لحساب إدارة', { exact: false }).waitFor();
  const before = (await (await page.request.post(BASE + 'api/v1/auth/login', { data: { email: 'sara@halqa.app', password: 'halqa123', client: 'native' } })).json()).user;
  await dialog().locator('#ad-e').fill('SARA@halqa.app');
  await dialog().getByRole('button', { name: 'إنشاء الحساب وإرسال رابط الإعداد' }).click();
  await dialog().getByText('مسجّل بالفعل كحساب طالب', { exact: false }).waitFor();
  await dialog().getByText('لم يُنشأ حساب جديد', { exact: false }).waitFor();
  await dialog().getByRole('button', { name: 'ترقية إلى معلم' }).click();
  await dialog().getByText('سيتم تحويل هذا الحساب', { exact: false }).waitFor();
  await dialog().locator('#pr-r').fill('انضمت إلى فريق المعلمين');
  await dialog().getByRole('button', { name: 'ترقية إلى معلم' }).click();
  await dialog().getByText('اكتب «ترقية» للتأكيد.').waitFor();
  await dialog().locator('#pr-c').fill('ترقية');
  await dialog().getByRole('button', { name: 'ترقية إلى معلم' }).click();
  await dialog().getByText('تمت ترقية الحساب إلى معلم. سيُطلب من المستخدم تسجيل الدخول من جديد.').waitFor();
  await dialog().getByRole('button', { name: 'تم' }).click();
  const after = (await (await page.request.post(BASE + 'api/v1/auth/login', { data: { email: 'sara@halqa.app', password: 'halqa123', client: 'native' } })).json()).user;
  if (after?.role !== 'teacher' || after.id !== before.id || after.email !== before.email) throw new Error(JSON.stringify({ before, after }));
  await settledReload(); await nav('المعلمون'); await openPerson('سارة أحمد');
  await dialog().getByRole('button', { name: 'اعتماد المعلم' }).waitFor(); // promoted, not approved by default
});
await step('a non-admin cannot call the admin API', async () => {
  const s = await b.newContext(); const r0 = await s.request.post(BASE + 'api/v1/auth/login', { data: { email: 'yousef@halqa.app', password: 'halqa123', client: 'native' } });
  const { token } = await r0.json();
  const r = await s.request.get(BASE + 'api/v1/admin/users', { headers: { Authorization: `Bearer ${token}` } });
  if (r.status() !== 403) throw new Error(`status ${r.status()}`);
  await s.close();
});
if (errs.length) { fails++; console.log('page errors:', errs); }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
