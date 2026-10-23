// Waiting list + make-up sessions (PROMPT 44), against a seeded dev server: node e2e/waitlist.mjs <shots-dir> [base-url]
// A full slot offers «الانضمام إلى قائمة الانتظار»; when the teacher cancels the booking the seat is offered to the
// student, who books it; a make-up credit for an approved excuse books a replacement with the same teacher.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { execSync } from 'node:child_process';
// SETUP_CMD prints «<full occurrence id> <excused past booking id>» (e2e/ci/waitlist_setup.py).
const ids = process.env.SETUP_CMD ? execSync(process.env.SETUP_CMD, { encoding: 'utf8' }).trim().split('\n').at(-1) : '';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
const page = await ctx.newPage(); page.setDefaultTimeout(10000);
const app = page.locator('main#scr');
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0].replace(/\u001b\[[0-9;]*m/g, '').slice(0, 300)); await page.screenshot({ path: `${out}/waitlist-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const token = async (email) => (await (await page.request.post(BASE + 'api/v1/auth/login', { data: { identifier: email, password: 'halqa123', client: 'native' } })).json()).token;
const apiAs = (t) => ({ get: (p) => page.request.get(BASE + 'api/v1/' + p, { headers: { Authorization: `Bearer ${t}` } }),
  post: (p, data = {}) => page.request.post(BASE + 'api/v1/' + p, { data, headers: { Authorization: `Bearer ${t}` } }) });

await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
await app.locator('#lg-email').fill('yousef@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click(); await app.getByText('السلام عليكم، يوسف').waitFor();
const openTeacher = async () => {
  await page.getByRole('button', { exact: true, name: 'الجلسات' }).click();
  await app.getByRole('tab', { name: 'المعلمون' }).click().catch(() => {});
  await app.getByText('الشيخ عبدالرحمن السالم').click();
  await app.getByText('جارٍ تحميل المواعيد…').waitFor({ state: 'detached' });
};

await step('a full slot offers «الانضمام إلى قائمة الانتظار»', async () => {
  await openTeacher();
  const full = app.getByRole('button', { name: /محجوز — الانضمام إلى قائمة الانتظار/ });
  let day = 2;
  for (; day < 7; day++) { await app.getByRole('option').nth(day).click(); if (await full.count()) break; }
  if (day === 7) throw new Error('no full slot found');
  await full.first().click();
  await page.getByText('الموعد مكتمل').waitFor();
  await page.getByRole('button', { name: 'الانضمام إلى قائمة الانتظار', exact: true }).click();
  await page.getByText('أُضفت إلى قائمة الانتظار (ترتيبك 1)').waitFor();
});
await step('«حجوزاتي» shows the place in the queue', async () => {
  await page.getByRole('button', { name: /رجوع/ }).first().click();
  await app.getByRole('tab', { name: 'حجوزاتي' }).click();
  await app.getByRole('heading', { name: 'قائمة الانتظار' }).waitFor();
  await app.getByText('ترتيبك في القائمة: 1').waitFor();
});
await step('the teacher cancels the booking; the seat is offered and booked', async () => {
  const sara = apiAs(await token('sara@halqa.app'));
  const booking = ((await (await sara.get('bookings')).json()).results ?? []).find((x) => x.status === 'confirmed');
  const t = apiAs(await token('teacher@halqa.app'));
  const r = await t.post(`bookings/${booking.id}/cancel`, { reason: 'ظرف طارئ' });
  if (!r.ok()) throw new Error('cancel ' + r.status());
  await page.reload(); await app.getByText('السلام عليكم، يوسف').waitFor();
  await page.getByRole('button', { exact: true, name: 'الجلسات' }).click(); await app.getByRole('tab', { name: 'حجوزاتي' }).click();
  await app.getByText(/توفّر مقعد لك!/).waitFor();
  await app.getByRole('button', { name: 'احجز المقعد' }).click();
  await page.getByText('تم حجز المقعد').waitFor();
});
await step('a make-up credit books a replacement with the same teacher', async () => {
  const t = apiAs(await token('teacher@halqa.app'));
  const past = ids.trim().split(/\s+/)[1];
  const g = await t.post(`bookings/${past}/makeup`);
  if (g.status() !== 201) throw new Error('grant ' + g.status());
  await page.reload(); await app.getByText('السلام عليكم، يوسف').waitFor();
  await page.getByRole('button', { exact: true, name: 'الجلسات' }).click(); await app.getByRole('tab', { name: 'حجوزاتي' }).click();
  await app.getByRole('heading', { name: 'جلسات تعويضية' }).waitFor();
  await app.getByRole('button', { name: 'احجز موعدًا تعويضيًا' }).click();
  await app.getByText('جارٍ تحميل المواعيد…').waitFor({ state: 'detached' });
  const free = app.locator('div[style*="grid"] button:not([disabled])').filter({ hasNotText: 'محجوز' });
  let day = 2;
  for (; day < 7; day++) { await app.getByRole('option').nth(day).click(); if (await free.count()) break; }
  await free.first().click();
  await app.getByRole('button', { exact: true, name: 'متابعة' }).click();
  await app.getByText('جلسة تعويضية: يُستخدم رصيدك التعويضي لهذا الحجز.').waitFor();
  await app.getByRole('button', { exact: true, name: 'تأكيد الحجز' }).click();
  await app.getByText('تم تأكيد حجزك').waitFor();
  const y = apiAs(await token('yousef@halqa.app'));
  const m = (await (await y.get('makeup')).json()).results[0];
  if (m.status !== 'used') throw new Error('credit ' + m.status);
});
await page.screenshot({ path: out + '/waitlist.png' });
if (errs.length) { fails++; console.log('page errors:', errs); }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
