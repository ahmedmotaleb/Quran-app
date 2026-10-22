// Live teacher schedule: open a slot → student books it → teacher sees it, cancels (student notified); attendance on a past session.
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
// Day index 2 = the day after tomorrow; pick 4:00 PM (16:00) which has no rule-generated slot.
let dayLabel = '';
await step(T.page, 'teacher opens a 4:00 PM slot', async () => {
  await T.page.getByRole('navigation').getByRole('button', { exact: true, name: 'المواعيد' }).click();
  await T.app.getByRole('tab', { name: 'الإتاحة' }).click();
  const chip = T.app.locator('button[aria-pressed]').nth(2); dayLabel = (await chip.textContent()).trim(); await chip.click();
  // Re-runnable: close the slot first if a previous run left it open.
  if (await T.app.getByRole('switch', { name: 'إتاحة 4:00 م', checked: true }).count()) {
    await T.app.getByRole('switch', { name: 'إتاحة 4:00 م' }).click(); await T.page.getByText('أُغلق الموعد').waitFor();
  }
  await T.app.getByRole('switch', { name: 'إتاحة 4:00 م', checked: false }).waitFor();
  await T.app.getByRole('switch', { name: 'إتاحة 4:00 م' }).click();
  await T.page.getByText('فُتح الموعد للحجز').waitFor();
  await T.app.getByRole('switch', { name: 'إتاحة 4:00 م', checked: true }).waitFor();
});
await T.page.screenshot({ path: out + '/t1-avail.png' });
const S = await session('sara@halqa.app');
await step(S.page, 'student books the new slot', async () => {
  await S.page.getByRole('navigation').getByRole('button', { exact: true, name: 'الجلسات' }).click();
  await S.app.getByText('الشيخ خالد العمري').click();
  await S.app.getByText('جارٍ تحميل المواعيد…').waitFor({ state: 'detached' });
  await S.app.getByRole('option').nth(2).click();
  await S.app.getByRole('button', { name: '4:00 م', exact: true }).click();
  await S.app.getByRole('button', { exact: true, name: 'متابعة' }).click();
  await S.app.getByRole('button', { exact: true, name: 'تأكيد الحجز' }).click();
  await S.app.getByText('تم تأكيد حجزك').waitFor();
});
await step(T.page, 'teacher sees booking; cannot close booked slot', async () => {
  await T.page.reload(); await T.app.getByText('مرحبًا، الشيخ خالد العمري').waitFor();
  await T.page.getByRole('navigation').getByRole('button', { exact: true, name: 'المواعيد' }).click();
  await T.app.getByRole('tab', { name: 'الجلسات' }).click();
  await T.app.getByText('سارة أحمد', { exact: true }).waitFor();
  await T.app.getByRole('tab', { name: 'الإتاحة' }).click();
  await T.app.locator('button[aria-pressed]').nth(2).click();
  await T.app.getByRole('switch', { name: 'إتاحة 4:00 م' }).click();
  await T.page.getByText('لا يمكن إغلاق موعد محجوز من هنا').waitFor();
});
await step(T.page, 'teacher cancels booking → student notified', async () => {
  await T.app.getByRole('tab', { name: 'الجلسات' }).click();
  await T.app.getByRole('button', { exact: true, name: 'إلغاء الحجز' }).first().click();
  await T.page.getByRole('button', { exact: true, name: 'نعم، ألغِ الحجز' }).click();
  await T.page.getByText('أُلغي الحجز وأُبلغ الطالب').waitFor();
  const r = await S.page.evaluate(async () => (await fetch('/api/v1/notifications', { credentials: 'include' })).json());
  if (!r.results.some((n) => n.kind === 'booking_cancelled')) throw new Error('no cancellation notification');
});
await step(T.page, 'teacher closes the now-free slot', async () => {
  await T.app.getByRole('tab', { name: 'الإتاحة' }).click();
  await T.app.locator('button[aria-pressed]').nth(2).click();
  await T.app.getByRole('switch', { name: 'إتاحة 4:00 م' }).click();
  await T.page.getByText('أُغلق الموعد').waitFor();
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
