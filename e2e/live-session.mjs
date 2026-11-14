// Meeting links, «انضم إلى الجلسة» and the 15-minute reminder (owner requests: pack prompt 19; 14 Nov 2026).
// A booking for يوسف starts in 5 minutes (SOON_CMD) with no meeting link yet. Checks:
//   - before a link exists, the student's «انضم إلى الجلسة» is disabled with the reason, and no call is simulated;
//   - the teacher pastes «meet.google.com/abc-defg-hij» without https. It is normalized on leaving the field, saved
//     as https in PostgreSQL, a host link is refused, and the teacher's own «انضم إلى الجلسة» opens the meeting;
//   - the student joins with ONE tap from the home card (no intermediate screen); the card shows the platform;
//   - the 15-minute reminder (created at once, since the session starts within 15 minutes) is in both inboxes, and
//     tapping it opens the session with «انضم إلى الجلسة»;
//   - another student cannot get the private link.
//   SOON_CMD="bash e2e/ci/py.sh soon_booking.py" node e2e/live-session.mjs <shots> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { pickWho } from './lib/who.mjs';
import { execSync } from 'node:child_process';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const MEET = 'https://meet.google.com/abc-defg-hij';
if (process.env.SOON_CMD) execSync(process.env.SOON_CMD, { stdio: 'inherit' });
const sql = (q) => execSync(`psql "${process.env.DATABASE_URL}" -At -c "${q}"`).toString().trim();
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
async function session(email, hello) {
  const ctx = await b.newContext({ viewport: { width: 360, height: 760 }, timezoneId: 'Africa/Cairo' });
  await ctx.route('https://meet.google.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Meet</title>' }));
  const page = await ctx.newPage(); page.setDefaultTimeout(10000);
  const app = page.locator('main#scr');
  await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await pickWho(app, email); await app.locator('#lg-email').fill(email); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText(hello).waitFor();
  return { ctx, page, app };
}
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${out}/live-session-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const join = (U) => U.app.getByTestId('join-session').first();
const opens = async (U, click) => {
  const popup = U.ctx.waitForEvent('page');
  await click();
  const p = await popup; await p.waitForLoadState();
  if (p.url() !== MEET) throw new Error('opened ' + p.url());
  await p.close();
};

const S = await session('yousef@halqa.app', 'السلام عليكم، يوسف');
await step(S.page, 'before a link exists the Join button is disabled with the reason; no call is simulated', async () => {
  await join(S).waitFor();
  if (!(await join(S).isDisabled())) throw new Error('enabled without a link');
  await S.app.getByText('لم يُضف رابط الجلسة بعد').first().waitFor();
  if (await S.app.getByText(/غرفة الانتظار|محاكاة|جارٍ الاتصال بالجلسة/).count()) throw new Error('simulated call shown');
});

const T = await session('teacher@halqa.app', 'مرحبًا، الأستاذ عبدالرحمن السالم');
await step(T.page, 'teacher: a link without https is normalized and saved as https; a host link is refused', async () => {
  await T.page.getByRole('navigation').getByRole('button', { exact: true, name: 'المواعيد' }).click();
  await T.app.getByRole('tab', { name: 'الجلسات' }).click();
  await T.app.getByRole('button', { exact: true, name: 'أضف الرابط' }).first().click();
  const field = T.app.getByLabel('رابط الدعوة للمشاركين');
  await field.fill('https://zoom.us/s/8312345678?zak=SECRET');
  await T.app.getByRole('button', { exact: true, name: 'حفظ' }).click();
  await T.app.getByText('هذا رابط المضيف', { exact: false }).waitFor();
  await field.fill('  meet.google.com/abc-defg-hij ');
  await field.blur();
  if ((await field.inputValue()) !== MEET) throw new Error(`not normalized on blur: ${await field.inputValue()}`);
  await T.app.getByRole('button', { exact: true, name: 'حفظ' }).click();
  await T.page.getByText('حُفظ رابط الجلسة').waitFor();
  await T.app.getByText('رابط Google Meet جاهز').first().waitFor();
  const stored = sql("select o.meeting_url from scheduling_sessionoccurrence o join scheduling_booking b on b.occurrence_id = o.id join accounts_user u on u.id = b.student_id where u.email = 'yousef@halqa.app' and b.status = 'confirmed' and o.meeting_url <> '' order by o.starts_at limit 1");
  if (stored !== MEET) throw new Error(`stored ${stored}`);
});
await step(T.page, 'teacher: «انضم إلى الجلسة» on the session and on today\'s board opens the meeting', async () => {
  await opens(T, () => join(T).click());
  await T.page.getByRole('navigation').getByRole('button', { exact: true, name: 'اليوم' }).click();
  await T.app.getByText('جلسات اليوم').waitFor();
  await opens(T, () => join(T).click());
});
await T.page.screenshot({ path: out + '/live-session-teacher.png' });

await step(S.page, 'student: ONE tap on the home card opens the meeting; the card and details show the platform', async () => {
  await S.page.reload(); await S.app.getByText('السلام عليكم، يوسف').waitFor();
  await S.app.getByText('Google Meet', { exact: false }).first().waitFor();
  await opens(S, () => join(S).click());
  await S.app.getByRole('button', { name: 'تفاصيل الجلسة' }).click();
  await S.app.getByText('منصة الاجتماع').waitFor();
  await opens(S, () => join(S).click());
});
await S.page.screenshot({ path: out + '/live-session-student.png' });

await step(S.page, '15-minute reminder in both inboxes; tapping it opens the session with «انضم إلى الجلسة»', async () => {
  const rows = sql("select u.email || '|' || n.title || '|' || n.body from notifications_notification n join accounts_user u on u.id = n.recipient_id where n.kind = 'session_soon' order by u.email");
  if (!rows.includes('teacher@halqa.app|الحلقة | تذكير بالجلسة|حلقتك') || !rows.includes('yousef@halqa.app|الحلقة | تذكير بالجلسة|حلقتك')) throw new Error(rows);
  if (sql("select count(*) from notifications_notification where kind = 'session_soon'") !== '2') throw new Error('duplicates');
  await S.page.goto(BASE + '#/inbox');
  await S.app.getByText('الحلقة | تذكير بالجلسة').first().click();
  await S.app.getByText('الجلسة المباشرة').first().waitFor();
  await opens(S, () => join(S).click());
  await T.page.goto(BASE + '#/inbox');
  await T.app.getByText('الحلقة | تذكير بالجلسة').first().waitFor();
});

const O = await session('sara@halqa.app', 'السلام عليكم، سارة');
await step(O.page, 'another student cannot get the private link', async () => {
  const bid = sql("select b.id from scheduling_booking b join accounts_user u on u.id = b.student_id where u.email = 'yousef@halqa.app' and b.status = 'confirmed' order by b.id desc limit 1");
  const r = await O.page.evaluate(async (id) => {
    const csrf = (await (await fetch('/api/v1/auth/csrf', { credentials: 'include' })).json()).csrfToken;
    const x = await fetch(`/api/v1/bookings/${id}/join`, { method: 'POST', credentials: 'include', headers: { 'X-CSRFToken': csrf } });
    return { status: x.status, text: await x.text() };
  }, bid);
  if (r.status !== 404 || r.text.includes('meet.google.com')) throw new Error(JSON.stringify(r));
});
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
