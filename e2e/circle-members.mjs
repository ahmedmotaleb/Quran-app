// Circle membership with automatic booking (owner decision 20 October): the admin creates and publishes a circle with
// two weekly sessions, adds a member (booked into both sessions), moves a second student in with «نقل إلى حلقة», sees
// the circle full, then removes a member (only future bookings cancelled; the student is notified).
//   node e2e/circle-members.mjs <shots> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await b.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo' }); page.setDefaultTimeout(10000);
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${out}/members-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const nav = (name) => page.getByRole('navigation', { name: 'التنقل في لوحة الإدارة' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
const dialog = () => page.getByRole('dialog').last();
const CN = `حلقة الأعضاء ${Date.now() % 100000}`;
const studentApi = async (email, path) => {
  const tok = (await (await page.request.post(BASE + 'api/v1/auth/login', { data: { email, password: 'halqa123', client: 'native' } })).json()).token;
  return (await page.request.get(BASE + 'api/v1/' + path, { headers: { Authorization: `Bearer ${tok}` } })).json();
};

await page.goto(BASE + '#/admin');
await page.locator('#ad-email').fill('admin@halqa.app'); await page.locator('#ad-pw').fill('halqa123');
await page.getByRole('button', { name: 'دخول' }).click(); await page.getByText(/بيانات حقيقية/).waitFor();

const pyDay = ((new Date().getDay() + 2) % 7 + 6) % 7; // two days ahead, Python Monday = 0
await step('create, schedule and publish a circle for 2 students', async () => {
  await nav('الحلقات'); await page.getByRole('button', { name: 'حلقة جديدة' }).click();
  await dialog().locator('#ci-n').fill(CN);
  await dialog().locator('#ci-t').selectOption({ label: 'الشيخ خالد العمري' });
  await dialog().locator('#ci-c').fill('2'); await dialog().getByRole('button', { name: 'حفظ' }).click();
  await dialog().getByText('لا توجد جلسات بعد').waitFor();
  await dialog().getByRole('button', { name: 'جدولة جلسات' }).click();
  await dialog().locator('#sc-d').selectOption(String(pyDay)); await dialog().locator('#sc-t').fill('07:15');
  await dialog().locator('#sc-m').fill('45'); await dialog().locator('#sc-w').fill('2');
  await dialog().getByRole('button', { name: 'معاينة' }).click();
  await dialog().getByRole('button', { name: 'إضافة 2 جلسة' }).click();
  await dialog().getByRole('button', { name: 'نشر' }).click(); await dialog().getByText('منشورة').waitFor();
});
await step('add a member: booked into both sessions', async () => {
  await dialog().getByLabel('إضافة طالب').selectOption({ label: 'يوسف أحمد' });
  await dialog().getByRole('button', { name: 'إضافة', exact: true }).click();
  await page.getByText('أُضيف إلى الحلقة وحُجزت 2 جلسة').waitFor();
  await dialog().getByText('(1/2)').waitFor();
  const bk = (await studentApi('yousef@halqa.app', 'bookings?when=upcoming')).results.filter((x) => x.occurrence.circle_name === CN && x.status === 'confirmed');
  if (bk.length !== 2) throw new Error('yousef bookings ' + bk.length);
});
await step('«نقل إلى حلقة» from the Students list fills the circle', async () => {
  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'detached' }).catch(() => {});
  await nav('الطلاب'); await page.getByRole('button', { name: 'سارة أحمد', exact: true }).waitFor();
  await page.getByRole('checkbox', { name: 'تحديد سارة أحمد' }).check();
  await page.getByRole('toolbar', { name: 'إجراءات على المحدد' }).getByRole('button', { name: 'نقل إلى حلقة', exact: true }).click();
  await dialog().getByLabel('الحلقة (المنشورة)').selectOption({ label: `${CN} (1/2)` });
  const resp = page.waitForResponse((r) => r.url().includes('/bulk-action'));
  await dialog().locator('button[type=submit]').click(); await resp;
  await page.getByText('تم تنفيذ الإجراء على عنصر واحد').waitFor();
  await page.waitForLoadState('networkidle');
  await nav('الحلقات'); await page.getByRole('button', { name: CN }).click();
  await dialog().getByText('(2/2)').waitFor();
  await dialog().getByRole('button', { name: 'الحلقة مكتملة' }).waitFor();
});
await step('remove a member: future bookings cancelled, student notified', async () => {
  await dialog().getByRole('button', { name: 'إزالة' }).first().click();
  await dialog().getByRole('button', { name: 'إزالة', exact: true }).last().click();
  await page.getByText(/أُزيل من الحلقة \(2 حجز أُلغي\)/).waitFor();
  await page.getByText('(1/2)').waitFor();
});
await page.screenshot({ path: out + '/circle-members.png' });
if (errs.length) { fails++; console.log('FAIL page errors', errs[0]); } else console.log('no page errors');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
