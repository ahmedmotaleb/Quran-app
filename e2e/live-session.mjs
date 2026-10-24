// Live sessions through a meeting link (pack prompt 19): the teacher adds the participant link (a host link is
// refused); the booked student opens it from the app inside the join window; the app shows no simulated call.
//   SOON_CMD="bash e2e/ci/py.sh soon_booking.py" node e2e/live-session.mjs <shots> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { execSync } from 'node:child_process';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const MEET = 'https://meet.google.com/abc-defg-hij';
if (process.env.SOON_CMD) execSync(process.env.SOON_CMD, { stdio: 'inherit' });
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
async function session(email, hello) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
  await ctx.route('https://meet.google.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Meet</title>' }));
  const page = await ctx.newPage(); page.setDefaultTimeout(10000);
  const app = page.locator('main#scr');
  await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.locator('#lg-email').fill(email); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText(hello).waitFor();
  return { ctx, page, app };
}
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${out}/live-session-fail-${name.replace(/\W+/g, '_')}.png` }); } };

const S = await session('yousef@halqa.app', 'السلام عليكم، يوسف');
await step(S.page, 'before a link exists the student is told so, and no call is simulated', async () => {
  await S.app.getByRole('button', { name: 'الدخول للجلسة' }).click();
  await S.app.getByText('لم يضف معلمك رابط الجلسة بعد.', { exact: false }).waitFor();
  if (await S.app.getByText(/غرفة الانتظار|محاكاة|جارٍ الاتصال بالجلسة/).count()) throw new Error('simulated call shown');
});

const T = await session('teacher@halqa.app', 'مرحبًا، الشيخ عبدالرحمن السالم');
await step(T.page, 'teacher: a host link is refused, the participant link is saved', async () => {
  await T.page.getByRole('navigation').getByRole('button', { exact: true, name: 'المواعيد' }).click();
  await T.app.getByRole('tab', { name: 'الجلسات' }).click();
  await T.app.getByRole('button', { exact: true, name: 'أضف الرابط' }).first().click();
  await T.app.getByLabel('رابط الدعوة للمشاركين').fill('https://zoom.us/s/8312345678?zak=SECRET');
  await T.app.getByRole('button', { exact: true, name: 'حفظ' }).click();
  await T.app.getByText('هذا رابط المضيف', { exact: false }).waitFor();
  await T.app.getByLabel('رابط الدعوة للمشاركين').fill(MEET);
  await T.app.getByRole('button', { exact: true, name: 'حفظ' }).click();
  await T.page.getByText('حُفظ رابط الجلسة').waitFor();
  await T.app.getByText('رابط الجلسة جاهز').first().waitFor();
});
await T.page.screenshot({ path: out + '/live-session-teacher.png' });

await step(S.page, 'student joins: the meeting opens in a new tab', async () => {
  await S.page.reload(); await S.app.getByText('السلام عليكم، يوسف').waitFor();
  await S.app.getByRole('button', { name: 'الدخول للجلسة' }).click();
  const popup = S.ctx.waitForEvent('page');
  await S.app.getByRole('button', { name: 'دخول الجلسة' }).click();
  const p = await popup; await p.waitForLoadState();
  if (p.url() !== MEET) throw new Error('opened ' + p.url());
  await S.app.getByRole('link', { name: 'افتح Google Meet' }).waitFor();  // fallback when a browser blocks the tab
});
await S.page.screenshot({ path: out + '/live-session-student.png' });
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
