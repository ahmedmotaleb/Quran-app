// Individual & group sessions with weekly recurrence (owner request 16 Nov 2026), through the real app, API and
// PostgreSQL: the teacher picks students from a searchable list (one for «فردية», two or more for «جماعية»), creates a
// weekly series with a different time per day and one meeting link, sees it in «الجلسات الأسبوعية»; both students see
// it (type, title, teacher, weekly) and get the notice; attendance and evaluation are recorded per student; removing a
// student updates their dashboard at once; an individual one-off session still works.
//   STARTED_CMD="bash e2e/ci/py.sh series_started.py" node e2e/group-sessions.mjs <shots> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { pickWho } from './lib/who.mjs';
import { execSync } from 'node:child_process';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0; const errs = [];
async function session(email, hello) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
  const page = await ctx.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', (e) => errs.push(e.message));
  const app = page.locator('main#scr');
  await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await pickWho(app, email); await app.locator('#lg-email').fill(email); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText(hello).waitFor();
  return { ctx, page, app };
}
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0].slice(0, 300)); await p.screenshot({ path: `${out}/group-fail-${name.replace(/\W+/g, '_')}.png`, fullPage: true }); } };
const api = (S, path) => S.page.evaluate(async (p) => (await fetch('/api/v1/' + p, { credentials: 'include' })).json(), path);
const cairo = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(d);
const TITLE = 'حلقة المساء';

const T = await session('teacher@halqa.app', 'مرحبًا، الأستاذ عبدالرحمن السالم');
const sched = async () => { await T.page.getByRole('navigation').getByRole('button', { exact: true, name: 'المواعيد' }).click(); await T.app.getByRole('tab', { name: 'الجلسات' }).click(); };
const form = () => T.page.getByRole('dialog', { name: 'إنشاء جلسة' });

await step(T.page, '1. group needs two or more students; the picker searches the teacher\'s own students and counts the selection', async () => {
  await sched();
  await T.app.getByRole('button', { name: 'إنشاء جلسة' }).click();
  const f = form();
  await f.getByRole('radio', { name: 'جماعية' }).click();
  const list = f.getByTestId('student-picker');
  await list.getByText('يوسف أحمد').waitFor(); await list.getByText('سارة أحمد').waitFor();
  await f.getByLabel('ابحث عن طالب').fill('سارة');
  if (await list.getByText('يوسف أحمد').count()) throw new Error('search did not filter');
  await f.getByLabel('ابحث عن طالب').fill('');
  await list.getByRole('checkbox', { name: 'يوسف أحمد' }).check();
  await f.getByTestId('picked-count').getByText('المحدَّدون: 1', { exact: false }).waitFor();
  await f.getByRole('button', { name: 'إنشاء الجلسة' }).click();
  await f.getByText('اختر طالبين أو أكثر للجلسة الجماعية.').waitFor();
});

await step(T.page, '2. weekly group series: two days with their own times, one meeting link (https added), created and listed', async () => {
  const f = form();
  await f.getByTestId('student-picker').getByRole('checkbox', { name: 'سارة أحمد' }).check();
  await f.getByTestId('picked-count').getByText('المحدَّدون: 2', { exact: false }).waitFor();
  await f.getByLabel('تكرار أسبوعي تلقائي').check();
  await f.getByRole('group', { name: 'أيام الأسبوع' }).getByRole('button', { name: 'الأحد' }).click();
  await f.getByRole('group', { name: 'أيام الأسبوع' }).getByRole('button', { name: 'الثلاثاء' }).click();
  await f.getByLabel('وقت الأحد').fill('19:00'); await f.getByLabel('وقت الثلاثاء').fill('20:30');
  await f.getByLabel('تبدأ من').fill(cairo(new Date()));
  await f.getByLabel('المدة').selectOption('60');
  const link = f.getByLabel('رابط الاجتماع (اختياري)');
  await link.fill('meet.google.com/abc-defg-hij'); await link.blur();
  if ((await link.inputValue()) !== 'https://meet.google.com/abc-defg-hij') throw new Error('link not normalized: ' + (await link.inputValue()));
  await f.getByLabel('العنوان (اختياري)').fill(TITLE);
  const resp = T.page.waitForResponse((r) => r.url().endsWith('/api/v1/teacher/series') && r.request().method() === 'POST');
  await f.getByRole('button', { name: 'إنشاء الجلسات الأسبوعية' }).click();
  const r = await resp; const body = await r.json();
  if (r.status() !== 201 || body.result.created < 4) throw new Error(`${r.status()} ${JSON.stringify(body).slice(0, 300)}`);
  await T.page.getByText('تم إنشاء الجلسات الأسبوعية', { exact: false }).waitFor();
  const card = T.app.getByTestId('series-card').filter({ hasText: TITLE });
  await card.getByText('الأحد ٧:٠٠ مساءً، والثلاثاء ٨:٣٠ مساءً', { exact: false }).waitFor();
  await card.getByText('المشاركون (2)').waitFor();
  const list = (await api(T, 'teacher/series')).results.find((x) => x.title === TITLE);
  if (!list || list.meeting_url !== 'https://meet.google.com/abc-defg-hij' || list.participants.filter((p) => p.active).length !== 2) throw new Error(JSON.stringify(list).slice(0, 300));
  const occ = await api(T, 'teacher/occurrences?days=15');
  const mine = occ.filter((o) => o.series === list.id);
  if (mine.length < 4 || mine.some((o) => o.bookings.length !== 2 || o.kind !== 'group')) throw new Error('sessions ' + JSON.stringify(mine.map((o) => [o.starts_at, o.bookings.length])));
  await T.page.screenshot({ path: out + '/group-series-teacher.png', fullPage: true });
});

const Y = await session('yousef@halqa.app', 'السلام عليكم، يوسف');
const S2 = await session('sara@halqa.app', 'السلام عليكم، سارة');
await step(Y.page, '3. each selected student sees the weekly group session (title, type, teacher, join) and got one notice', async () => {
  for (const S of [Y, S2]) {
    const mine = await api(S, 'bookings?when=upcoming&status=confirmed');
    const rows = (mine.results ?? mine).filter((x) => x.occurrence.title === TITLE);
    if (rows.length < 4 || rows.some((x) => x.occurrence.kind !== 'group' || !x.occurrence.series || !x.has_meeting_link)) throw new Error('bookings ' + rows.length);
    const n = await api(S, 'notifications');
    if ((n.results ?? n).filter((x) => x.kind === 'series_added').length !== 1) throw new Error('series notice');
  }
  await Y.page.getByRole('navigation').getByRole('button', { exact: true, name: 'الجلسات' }).click();
  await Y.app.getByRole('tab', { name: 'حجوزاتي' }).click().catch(() => {});
  await Y.app.getByText(TITLE).first().waitFor();
  await Y.app.getByText('جماعية · أسبوعية', { exact: false }).first().waitFor();
  await Y.page.screenshot({ path: out + '/group-series-student.png', fullPage: true });
});

await step(T.page, '4. attendance and evaluation are recorded for each student separately', async () => {
  execSync(process.env.STARTED_CMD || 'bash e2e/ci/py.sh series_started.py', { stdio: 'inherit' });
  await T.page.reload(); await T.app.getByRole('button', { exact: true, name: 'تخطَّ' }).click().catch(() => {});
  await sched();
  const att = (n) => T.app.getByRole('radiogroup', { name: `حضور ${n}` }).first();
  await att('يوسف أحمد').getByRole('radio', { name: 'حاضر' }).click();
  await T.page.getByText('حُفظ الحضور').first().waitFor();
  await att('سارة أحمد').getByRole('radio', { name: 'غائب', exact: true }).click();
  await T.page.waitForTimeout(800);
  await T.app.getByRole('button', { name: 'تقييم يوسف أحمد' }).first().click();
  const fy = T.app.getByRole('form', { name: 'تقييم يوسف أحمد' });
  await fy.getByRole('radiogroup', { name: 'تقدير الحفظ' }).getByRole('radio', { name: 'ممتاز' }).click();
  await fy.getByRole('radiogroup', { name: 'تقدير التجويد' }).getByRole('radio', { name: 'جيد جدًا' }).click();
  await fy.getByLabel('ملاحظة المعلم').fill('أحسنت، راجع المدود');
  await fy.getByRole('button', { name: 'حفظ التقييم' }).click();
  await T.page.getByText('حُفظ تقييم يوسف أحمد').waitFor();
  await T.app.getByRole('button', { name: 'تقييم سارة أحمد' }).first().click();
  const fs = T.app.getByRole('form', { name: 'تقييم سارة أحمد' });
  await fs.getByRole('radiogroup', { name: 'تقدير التجويد' }).getByRole('radio', { name: 'يحتاج إلى مراجعة' }).click();
  await fs.getByRole('button', { name: 'حفظ التقييم' }).click();
  await T.page.getByText('حُفظ تقييم سارة أحمد').waitFor();
  const occ = await api(T, 'teacher/occurrences?days=15');
  const started = occ.find((o) => o.title === TITLE && new Date(o.starts_at) < new Date());
  const by = Object.fromEntries(started.bookings.map((x) => [x.student_name, [x.attendance, x.evaluation?.memorization_grade, x.evaluation?.tajweed_grade]]));
  if (JSON.stringify(by['يوسف أحمد']) !== JSON.stringify(['present', 'excellent', 'very_good']) || JSON.stringify(by['سارة أحمد']) !== JSON.stringify(['absent', '', 'needs_work']))
    throw new Error(JSON.stringify(by));
  const yb = started.bookings.find((x) => x.student_name === 'يوسف أحمد').id;
  const own = await api(Y, `bookings/${yb}`);
  if (own.evaluation?.note !== 'أحسنت، راجع المدود') throw new Error('student evaluation ' + JSON.stringify(own.evaluation));
  const other = started.bookings.find((x) => x.student_name === 'سارة أحمد').id;
  const peek = await Y.page.evaluate(async (id) => (await fetch(`/api/v1/bookings/${id}`, { credentials: 'include' })).status, other);
  if (peek !== 404) throw new Error('a classmate\'s record was visible: ' + peek);
});

await step(S2.page, '5. removing a student from the weekly group updates their dashboard at once; history stays', async () => {
  await sched();
  const card = T.app.getByTestId('series-card').filter({ hasText: TITLE });
  await card.getByRole('button', { name: 'إزالة سارة أحمد' }).click();
  await T.page.getByRole('dialog').getByRole('button', { name: 'إزالة' }).click();
  await T.page.getByText('أُزيل سارة أحمد').waitFor();
  await card.getByText('المشاركون (1)').waitFor();
  // The student's app polls the sync mark every minute and on returning to the app; returning is simulated here.
  await S2.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await S2.page.waitForFunction(async (t) => {
    const r = await (await fetch('/api/v1/bookings?when=upcoming&status=confirmed', { credentials: 'include' })).json();
    return !(r.results ?? r).some((x) => x.occurrence.title === t && new Date(x.occurrence.starts_at) > new Date());
  }, TITLE);
  const n = await api(S2, 'notifications');
  if (!(n.results ?? n).some((x) => x.kind === 'series_removed')) throw new Error('no removal notice');
  const all = await api(S2, 'bookings');   // the session that already started keeps her booking and attendance
  if (!(all.results ?? all).some((x) => x.occurrence.title === TITLE && x.status === 'confirmed' && x.attendance === 'absent')) throw new Error('history lost');
});

await step(T.page, '6. an individual one-off session for one chosen student still works', async () => {
  await T.app.getByRole('button', { name: 'إنشاء جلسة' }).click();
  const f = form();
  await f.getByRole('radio', { name: 'فردية' }).click();
  await f.getByTestId('student-picker').getByRole('radio', { name: 'يوسف أحمد' }).check();
  await f.getByLabel('التاريخ').fill(cairo(new Date(Date.now() + 5 * 86_400_000))); await f.getByLabel('الوقت').fill('10:15');
  await f.getByRole('button', { name: 'إنشاء الجلسة' }).click();
  await T.page.getByText('تم إنشاء الجلسة وأُبلغ الطالب.').waitFor();
});

await step(T.page, '7. no browser errors', async () => { if (errs.length) throw new Error(errs.slice(0, 3).join(' | ')); });
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
