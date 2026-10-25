// Live teacher schedule: availability ranges → student books a computed time → teacher sees it, cancels (student
// notified); attendance on a past session.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { execSync } from 'node:child_process';
// PAST_CMD (optional): creates a booked session that already happened for teacher@halqa.app (needed for attendance).
const out = process.argv[2]; const BASE = process.argv[3] || 'http://localhost:5174/';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0; const errs = [];
async function session(email) {
  const page = await (await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' })).newPage(); page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => errs.push(e.message));
  const app = page.locator('main#scr');
  await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.locator('#lg-email').fill(email); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  return { page, app };
}
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${out}/fail-${name.replace(/\W+/g, '_')}.png` }); } };
const T = await session('khalid@halqa.app');
await T.app.getByText('مرحبًا، الشيخ خالد العمري').waitFor();
// Availability as time ranges anywhere in the day (owner request, 25 Oct 2026): the teacher adds a morning range on
// the day after tomorrow, an overlap is refused, a part of the day is blocked; the student sees only the computed free
// times and books one; the teacher sees the session apart from the ranges, cancels it, and removes the range.
const days = () => T.app.getByRole('tablist', { name: 'اختر اليوم' }).getByRole('tab');
const pickTime = async (sheet, label, hh, mm, ampm) => {
  const id = label === 'من' ? '#av-from' : '#av-to';
  await sheet.locator(id).selectOption(String(hh)); await sheet.locator(id + '-m').selectOption(String(mm));
  await sheet.getByRole('radiogroup', { name: `${label}: صباحًا أو مساءً` }).getByRole('radio', { name: ampm }).click();
};
await step(T.page, 'teacher adds a morning range (06:00–11:00) — no fixed times', async () => {
  await T.page.getByRole('navigation').getByRole('button', { exact: true, name: 'المواعيد' }).click();
  await T.app.getByRole('tab', { name: 'الإتاحة' }).click();
  await T.app.getByText('الأوقات بتوقيت القاهرة', { exact: false }).waitFor();
  if (await T.app.getByRole('switch').count()) throw new Error('old availability switches still shown');
  await days().nth(2).click();
  await T.app.getByRole('button', { name: '+ إضافة فترة إتاحة' }).click();
  const sh = T.page.getByRole('dialog', { name: /^إضافة فترة/ });
  await pickTime(sh, 'من', 6, 0, 'ص'); await pickTime(sh, 'إلى', 11, 0, 'ص');
  await sh.locator('#av-min').selectOption('45');
  await sh.getByRole('button', { name: 'حفظ', exact: true }).click();
  await T.page.getByText('أُضيفت الفترة').waitFor();
  await T.app.locator('[data-range="06:00-11:00"]').getByText('6:00 ص — 11:00 ص').waitFor();
});
await step(T.page, 'an overlapping range is refused; a late-night range runs past midnight', async () => {
  await T.app.getByRole('button', { name: '+ إضافة فترة إتاحة' }).click();
  let sh = T.page.getByRole('dialog', { name: /^إضافة فترة/ });
  await pickTime(sh, 'من', 10, 0, 'ص'); await pickTime(sh, 'إلى', 12, 0, 'م');
  await sh.getByRole('button', { name: 'حفظ', exact: true }).click();
  await sh.getByText('تتداخل هذه الفترة', { exact: false }).waitFor();
  await sh.getByRole('button', { name: 'إلغاء', exact: true }).click();
  await T.app.getByRole('button', { name: '+ إضافة فترة إتاحة' }).click();
  sh = T.page.getByRole('dialog', { name: /^إضافة فترة/ });
  await pickTime(sh, 'من', 11, 0, 'م'); await pickTime(sh, 'إلى', 1, 0, 'ص');
  await sh.getByText('تمتد هذه الفترة بعد منتصف الليل').waitFor();
  await sh.getByRole('button', { name: 'حفظ', exact: true }).click();
  await T.app.locator('[data-range="23:00-01:00"]').getByText('تمتد إلى اليوم التالي', { exact: false }).waitFor();
});
await step(T.page, 'teacher blocks 7:00–8:00 that date only (private reason)', async () => {
  await T.app.getByRole('button', { name: 'حظر وقت', exact: true }).click();
  const sh = T.page.getByRole('dialog', { name: /^حظر وقت/ });
  await pickTime(sh, 'من', 7, 0, 'ص'); await pickTime(sh, 'إلى', 8, 0, 'ص');
  await sh.locator('#av-reason').fill('موعد شخصي');
  await sh.getByRole('button', { name: 'حفظ', exact: true }).click();
  await T.page.getByText('حُظر الوقت').waitFor();
  const st = T.app.getByRole('region', { name: 'حالة اليوم' });
  await st.getByText('7:00 ص — 8:00 ص').waitFor(); await st.getByText('غير متاح', { exact: true }).first().waitFor();
});
await T.page.screenshot({ path: out + '/t1-avail.png', fullPage: true });
const S = await session('sara@halqa.app');
await step(S.page, 'student sees only computed free times and books 6:00 AM', async () => {
  await S.page.getByRole('navigation').getByRole('button', { exact: true, name: 'الجلسات' }).click();
  await S.app.getByText('الشيخ خالد العمري').click();
  await S.app.getByText('جارٍ تحميل المواعيد…').waitFor({ state: 'detached' });
  await S.app.getByRole('option').nth(2).click();
  await S.app.getByRole('button', { name: '6:15 ص', exact: true }).waitFor();                 // 6:15 + 45 = 7:00 (block starts)
  for (const t of ['6:30 ص', '7:30 ص', '5:45 ص']) if (await S.app.getByRole('button', { name: t, exact: true }).count()) throw new Error(`${t} offered`);
  await S.app.getByRole('button', { name: '6:00 ص', exact: true }).click();
  await S.app.getByRole('button', { exact: true, name: 'متابعة' }).click();
  await S.app.getByRole('button', { exact: true, name: 'تأكيد الحجز' }).click();
  await S.app.getByText('تم تأكيد حجزك').waitFor();
});
await step(T.page, 'teacher sees the session apart from the ranges', async () => {
  await T.page.reload(); await T.app.getByText('مرحبًا، الشيخ خالد العمري').waitFor();
  await T.page.getByRole('navigation').getByRole('button', { exact: true, name: 'المواعيد' }).click();
  await T.app.getByRole('tab', { name: 'الجلسات' }).click();
  await T.app.getByText('سارة أحمد', { exact: true }).waitFor();
  await T.app.getByRole('tab', { name: 'الإتاحة' }).click();
  await days().nth(2).click();
  const sess = T.app.getByRole('region', { name: 'جلسات اليوم' });
  await sess.getByText('سارة أحمد', { exact: false }).waitFor();
  await T.app.getByRole('region', { name: 'حالة اليوم' }).getByRole('listitem').filter({ hasText: 'محجوز' }).first().waitFor();
  if (await T.app.getByRole('region', { name: 'الإتاحة' }).getByText('سارة أحمد').count()) throw new Error('session mixed into the ranges');
});
await step(T.page, 'teacher cancels booking → student notified', async () => {
  await T.app.getByRole('tab', { name: 'الجلسات' }).click();
  await T.app.getByRole('button', { exact: true, name: 'إلغاء الحجز' }).first().click();
  await T.page.getByRole('button', { exact: true, name: 'نعم، ألغِ الحجز' }).click();
  await T.page.getByText('أُلغي الحجز وأُبلغ الطالب').waitFor();
  const r = await S.page.evaluate(async () => (await fetch('/api/v1/notifications', { credentials: 'include' })).json());
  if (!r.results.some((n) => n.kind === 'booking_cancelled')) throw new Error('no cancellation notification');
});
await step(T.page, 'teacher removes the morning range', async () => {
  await T.app.getByRole('tab', { name: 'الإتاحة' }).click();
  await days().nth(2).click();
  await T.app.getByRole('button', { name: 'حذف 6:00 ص — 11:00 ص' }).click();
  await T.page.getByRole('dialog', { name: 'حذف الفترة؟' }).getByRole('button', { name: 'حذف', exact: true }).click();
  await T.page.getByText('حُذفت الفترة').waitFor();
  await T.app.locator('[data-range="06:00-11:00"]').waitFor({ state: 'detached' });
});
if (process.env.PAST_CMD) execSync(process.env.PAST_CMD, { stdio: 'inherit' });
const Y = await session('teacher@halqa.app');
await step(Y.page, 'attendance on a past session', async () => {
  await Y.page.getByRole('navigation').getByRole('button', { exact: true, name: 'المواعيد' }).click();
  await Y.app.getByRole('radio', { name: 'غائب', exact: true }).first().click();
  await Y.page.getByText('حُفظ الحضور').waitFor();
  await Y.app.getByRole('radio', { name: 'غائب', exact: true, checked: true }).first().waitFor();
});
await Y.page.screenshot({ path: out + '/t2-sessions.png' });
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no page errors');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0; await b.close();
