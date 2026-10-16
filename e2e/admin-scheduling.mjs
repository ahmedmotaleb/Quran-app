// Live admin circles and bookings (pack prompt 06), against a seeded dev server:
//   node e2e/admin-scheduling.mjs <shots-dir> [base-url]
// Admin creates a circle, schedules sessions (preview first), publishes; a student books through the API; the admin
// sees and cancels the booking; the student is notified; the admin cancels a whole session. Reloads before checks.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { trackWrites } from './lib/settle.mjs';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await b.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo' }); page.setDefaultTimeout(10000);
const { settledReload } = trackWrites(page);
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${out}/sched-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const nav = (name) => page.getByRole('navigation', { name: 'أقسام الإدارة' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
const dialog = () => page.getByRole('dialog').last();
const CN = `حلقة الاختبار ${Date.now() % 100000}`;
const api = async (method, path, token, data, headers = {}) => {
  const r = await page.request.fetch(BASE + 'api/v1/' + path, { method, data, headers: { Authorization: `Bearer ${token}`, ...headers } });
  return { status: r.status(), body: await r.json().catch(() => null) };
};
const tokenFor = async (email) => (await (await page.request.post(BASE + 'api/v1/auth/login', { data: { email, password: 'halqa123', client: 'native' } })).json()).token;

await page.goto(BASE + '#/admin');
await page.locator('#ad-email').fill('admin@halqa.app'); await page.locator('#ad-pw').fill('halqa123');
await page.getByRole('button', { name: 'دخول' }).click(); await page.getByText(/بيانات حقيقية/).waitFor();

await step('create a circle (draft)', async () => {
  await nav('الحلقات'); await page.getByRole('button', { name: 'حلقة جديدة' }).click();
  await dialog().locator('#ci-n').fill(CN);
  await dialog().locator('#ci-t').selectOption({ label: 'الشيخ خالد العمري' });
  await dialog().locator('#ci-c').fill('3'); await dialog().getByRole('button', { name: 'حفظ' }).click();
  await dialog().getByText('لا توجد جلسات بعد').waitFor();
});
const day = (new Date().getDay() + 2) % 7; // two days ahead, JS Sunday = 0
const pyDay = (day + 6) % 7; // Python Monday = 0
await step('preview then schedule 2 weekly sessions', async () => {
  await dialog().getByRole('button', { name: 'جدولة جلسات' }).click();
  await dialog().locator('#sc-d').selectOption(String(pyDay)); await dialog().locator('#sc-t').fill('06:30');
  await dialog().locator('#sc-m').fill('45'); await dialog().locator('#sc-w').fill('2');
  await dialog().getByRole('button', { name: 'معاينة' }).click();
  await dialog().getByRole('button', { name: 'إضافة 2 جلسة' }).click();
  await settledReload(); await nav('الحلقات'); await page.getByRole('button', { name: CN }).click();
  await dialog().getByRole('button', { name: 'إلغاء الجلسة' }).first().waitFor();
  if (await dialog().getByRole('button', { name: 'إلغاء الجلسة' }).count() !== 2) throw new Error('expected 2 sessions');
});
let student = ''; let occId = 0;
await step('draft circle is hidden from students', async () => {
  student = await tokenFor('yousef@halqa.app');
  const teachers = (await api('GET', 'teachers', student)).body.results;
  const khalid = teachers.find((t) => t.full_name === 'الشيخ خالد العمري');
  const slots = (await api('GET', `teachers/${khalid.id}/slots`, student)).body;
  if (slots.some((s) => s.circle_name === CN)) throw new Error('draft circle visible');
});
await step('publish; the student sees and books a group seat', async () => {
  await dialog().getByRole('button', { name: 'نشر' }).click(); await dialog().getByText('منشورة').waitFor();
  const teachers = (await api('GET', 'teachers', student)).body.results;
  const khalid = teachers.find((t) => t.full_name === 'الشيخ خالد العمري');
  const slot = (await api('GET', `teachers/${khalid.id}/slots`, student)).body.find((s) => s.circle_name === CN);
  if (!slot || slot.seats_left !== 3) throw new Error('published circle session not offered');
  occId = slot.id;
  const r = await api('POST', 'bookings', student, { occurrence: occId }, { 'Idempotency-Key': `e2e-${Date.now()}` });
  if (r.status !== 201) throw new Error(`book ${r.status} ${JSON.stringify(r.body)}`);
});
await step('the booking appears in admin Bookings; cancel with a reason', async () => {
  await page.keyboard.press('Escape'); await nav('الحجوزات');
  await page.getByRole('searchbox').fill('يوسف');
  const btn = page.getByRole('button', { name: 'إلغاء حجز يوسف أحمد' }).first(); await btn.click();
  await dialog().locator('#rs').fill('اختبار إلغاء الإدارة'); await dialog().getByRole('button', { name: 'إلغاء الحجز' }).click();
  await settledReload(); await nav('الحجوزات');
  await page.getByRole('button', { name: 'ملغاة', exact: true }).click(); await page.getByText('اختبار إلغاء الإدارة').first().waitFor();
});
await step('the student is notified and the seat is free again', async () => {
  const n = (await api('GET', 'notifications', student)).body; const items = n.results ?? n;
  if (!items.some((x) => x.kind === 'booking_cancelled')) throw new Error('no cancellation notice');
  const teachers = (await api('GET', 'teachers', student)).body.results;
  const khalid = teachers.find((t) => t.full_name === 'الشيخ خالد العمري');
  const slot = (await api('GET', `teachers/${khalid.id}/slots`, student)).body.find((s) => s.id === occId);
  if (slot.seats_left !== 3) throw new Error(`seats_left ${slot.seats_left}`);
});
await step('cancel a whole session from the circle panel', async () => {
  const sara = await tokenFor('sara@halqa.app');
  const r = await api('POST', 'bookings', sara, { occurrence: occId }, { 'Idempotency-Key': `e2e-s-${Date.now()}` });
  if (r.status !== 201) throw new Error(`book ${r.status}`);
  await nav('الحلقات'); await page.getByRole('button', { name: CN }).click();
  await dialog().getByText('1/3').waitFor();
  await dialog().getByRole('button', { name: 'إلغاء الجلسة' }).first().click();
  await dialog().locator('#rs').fill('عذر طارئ للمعلم'); await dialog().getByRole('button', { name: 'إلغاء الجلسة' }).click();
  await settledReload(); await nav('الحلقات'); await page.getByRole('button', { name: CN }).click();
  await dialog().getByText('ملغاة').waitFor(); // the cancelled session row
  if (await dialog().getByRole('button', { name: 'إلغاء الجلسة' }).count() !== 1) throw new Error('session not cancelled');
  const mine = (await api('GET', 'bookings', sara)).body.results.find((x) => x.occurrence.id === occId);
  if (mine.status !== 'cancelled') throw new Error('student booking still confirmed');
});
await page.screenshot({ path: out + '/sched-circle.png' });
if (errs.length) { fails++; console.log('page errors:', errs); }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
