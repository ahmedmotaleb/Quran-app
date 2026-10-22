// Permanent account deletion (owner decision 22 October 2026). From the person panel: «حذف نهائي» asks for a reason
// and the typed word «حذف»; the student disappears from the list and can no longer sign in. From the Students list,
// the bulk «حذف نهائي» also needs «حذف» even for one person.
//   node e2e/account-delete.mjs <shots> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await b.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo' }); page.setDefaultTimeout(10000);
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${out}/delete-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const dialog = () => page.getByRole('dialog').last();
const signIn = (email) => page.request.post(BASE + 'api/v1/auth/login', { data: { email, password: 'halqa123', client: 'native' } });

await page.goto(BASE + '#/admin');
await page.locator('#ad-email').fill('admin@halqa.app'); await page.locator('#ad-pw').fill('halqa123');
await page.getByRole('button', { name: 'دخول' }).click(); await page.getByText(/بيانات حقيقية/).waitFor();
await page.getByRole('navigation', { name: 'أقسام الإدارة' }).getByRole('button', { name: /^الطلاب/ }).click();
await page.getByRole('button', { name: 'يوسف أحمد', exact: true }).waitFor();

await step('person panel: «حذف نهائي» needs a reason and the typed word', async () => {
  if (!(await signIn('yousef@halqa.app')).ok()) throw new Error('yousef cannot sign in before deletion');
  await page.getByRole('button', { name: 'يوسف أحمد', exact: true }).click();
  await dialog().getByRole('button', { name: 'حذف نهائي' }).click();
  await dialog().getByText('ولا يمكن التراجع').waitFor();
  await dialog().locator('#rs').fill('طلب ولي الأمر حذف الحساب');
  await dialog().getByRole('button', { name: 'حذف نهائي' }).click();
  await dialog().getByText('اكتب «حذف» للتأكيد.').waitFor();
  await dialog().locator('#rs-c').fill('حذف');
  const resp = page.waitForResponse((r) => r.url().includes('/bulk-action'));
  await dialog().getByRole('button', { name: 'حذف نهائي' }).click(); await resp;
  await page.getByText('حُذف الحساب نهائيًا').waitFor();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'يوسف أحمد', exact: true }).waitFor({ state: 'detached' });
  const r = await signIn('yousef@halqa.app');
  if (r.ok()) throw new Error('deleted student can still sign in');
});
await step('bulk «حذف نهائي» asks for «حذف» even for one student', async () => {
  await page.getByRole('checkbox', { name: 'تحديد سارة أحمد' }).check();
  await page.getByRole('toolbar', { name: 'إجراءات على المحدد' }).getByRole('button', { name: 'حذف نهائي', exact: true }).click();
  await dialog().locator('#bk-r').fill('حساب مكرر');
  await dialog().locator('button[type=submit]').click();
  await dialog().getByText('اكتب «حذف» للتأكيد.').waitFor();
  await dialog().locator('#bk-c').fill('حذف');
  const resp = page.waitForResponse((r) => r.url().includes('/bulk-action'));
  await dialog().locator('button[type=submit]').click();
  const body = await (await resp).json();
  if (body.success !== 1) throw new Error('bulk delete ' + JSON.stringify(body));
  await page.waitForLoadState('networkidle');
  const res = page.getByRole('dialog').filter({ hasText: 'نتيجة' }); if (await res.count()) await res.getByRole('button', { name: 'تم' }).click();
  await page.getByRole('button', { name: 'سارة أحمد', exact: true }).waitFor({ state: 'detached' });
});
await page.screenshot({ path: out + '/account-delete.png' });
if (errs.length) { fails++; console.log('FAIL page errors', errs[0]); } else console.log('no page errors');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
