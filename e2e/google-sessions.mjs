// Google Calendar + Meet (owner request 24 Oct), against the development stand-in for Google (GOOGLE_FAKE):
// teacher connects Google Calendar → creates a session for a student (no pasted link) → Meet ready; the student sees
// «جلسة حفظ», the join button only inside the window and it opens the SAME Meet; the teacher moves the session (the
// student sees the new time) and cancels it (the student sees the cancellation).
//   SOON_CMD="bash e2e/ci/py.sh google_soon.py" node e2e/google-sessions.mjs <shots> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { execSync } from 'node:child_process';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0; const errs = [];
async function session(email, hello) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
  await ctx.route('https://meet.google.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Meet</title>' }));
  const page = await ctx.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', (e) => errs.push(e.message));
  const app = page.locator('main#scr');
  await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.locator('#lg-email').fill(email); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText(hello).waitFor();
  return { ctx, page, app };
}
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0].slice(0, 300)); await p.screenshot({ path: `${out}/google-fail-${name.replace(/\W+/g, '_')}.png`, fullPage: true }); } };
const cairo = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(d);
const day2 = cairo(new Date(Date.now() + 2 * 86_400_000));
let meet = '';

const T = await session('teacher@halqa.app', 'مرحبًا، الشيخ عبدالرحمن السالم');
const sched = async () => { await T.page.getByRole('navigation').getByRole('button', { exact: true, name: 'المواعيد' }).click(); await T.app.getByRole('tab', { name: 'الجلسات' }).click(); };

await step(T.page, 'teacher: without Google the form says to connect first', async () => {
  await sched();
  await T.app.getByRole('button', { name: 'إنشاء جلسة' }).click();
  await T.page.getByText('اربط Google Calendar من «حسابي» أولًا لإنشاء الجلسة.').waitFor();
  await T.page.getByRole('button', { name: 'إغلاق' }).click();
});

await step(T.page, 'teacher: «ربط Google Calendar» → consent → «Google Calendar متصل» (masked email)', async () => {
  await T.page.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  await T.app.getByRole('button', { name: 'ربط Google Calendar' }).click();
  await T.app.getByText(/Google Calendar متصل/).first().waitFor();
  await T.app.getByText('te••••••••••••••@example.com').waitFor();
  const html = await T.page.content();
  if (/fake-refresh|fake-access|refresh_token|access_token/.test(html)) throw new Error('token in the page');
  await T.app.getByRole('button', { name: 'إعادة الربط' }).waitFor(); await T.app.getByRole('button', { name: 'قطع الاتصال' }).waitFor();
});

await step(T.page, 'teacher: create a «حفظ» session for Yousef — Google Meet created automatically', async () => {
  await sched();
  await T.app.getByRole('button', { name: 'إنشاء جلسة' }).click();
  const f = T.page.getByRole('dialog', { name: 'إنشاء جلسة' });
  await f.getByRole('button', { name: 'إنشاء الجلسة' }).click();
  await f.getByText('اختر طالبًا أو حلقة.').waitFor();
  await f.getByLabel('الطالب أو الحلقة').selectOption({ label: 'يوسف أحمد' });
  await f.getByRole('radio', { name: 'حفظ' }).click();
  await f.getByLabel('التاريخ').fill(day2); await f.getByLabel('الوقت').fill('23:15');
  await f.getByLabel('العنوان (اختياري)').fill('سورة الملك');
  await f.getByLabel('ملاحظة تحضير للطالب (اختياري)').fill('راجع الآيات 1–10 قبل الجلسة');
  const resp = T.page.waitForResponse((r) => r.url().endsWith('/api/v1/teacher/sessions') && r.request().method() === 'POST');
  await f.getByRole('button', { name: 'إنشاء الجلسة' }).click();
  const r = await resp; const body = await r.json();
  if (r.status() !== 201 || body.google?.sync_status !== 'ready' || !r.request().headers()['idempotency-key']) throw new Error(`${r.status()} ${JSON.stringify(body).slice(0, 200)}`);
  meet = body.meeting_url;
  if (!/^https:\/\/meet\.google\.com\/[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}$/.test(meet)) throw new Error('meet ' + meet);
  await T.page.getByText('أُنشئت الجلسة وأُرسلت الدعوة').waitFor();
  await T.app.getByText('Google Meet جاهز ✓').first().waitFor();
  const link = T.app.getByRole('link', { name: 'فتح Google Meet' }).first();
  if ((await link.getAttribute('href')) !== meet) throw new Error('teacher link differs');
  await T.app.getByRole('link', { name: 'فتح في Google Calendar' }).first().waitFor();
});
await T.page.screenshot({ path: out + '/google-teacher.png', fullPage: true });

const S = await session('yousef@halqa.app', 'السلام عليكم، يوسف');
const myBookings = async () => {
  await S.page.getByRole('navigation').getByRole('button', { exact: true, name: 'الجلسات' }).click();
  await S.app.getByRole('tab', { name: 'حجوزاتي' }).click();
};
const openSession = async () => {
  await myBookings();
  await S.app.getByRole('button', { name: /الشيخ عبدالرحمن السالم · فردية/ }).first().click();
};
await step(S.page, 'student: the session appears as «جلسة حفظ», with the preparation note; no join button yet', async () => {
  await openSession();
  await S.app.getByText('جلسة حفظ — سورة الملك').waitFor();
  await S.app.getByText('للتحضير: راجع الآيات 1–10 قبل الجلسة').waitFor();
  await S.app.getByText(/سيظهر زر الدخول قبل الموعد بـ \d+ دقيقة/).waitFor();
  await S.app.getByRole('button', { name: 'إضافة إلى التقويم' }).waitFor();
  if (await S.app.getByRole('button', { name: 'إعادة الجدولة' }).count()) throw new Error('student can rebook a teacher-created session');
  const html = await S.page.content(); if (html.includes(meet)) throw new Error('Meet URL visible before the join window');
});

await step(T.page, 'teacher: «تعديل الموعد» moves the same session; the student sees the new time', async () => {
  await T.app.getByRole('button', { name: 'تعديل الموعد' }).first().click();
  const f = T.app.getByRole('form', { name: 'تعديل الموعد' });
  await f.getByLabel('الوقت').fill('23:30');
  const resp = T.page.waitForResponse((r) => /\/teacher\/sessions\/\d+$/.test(r.url()) && r.request().method() === 'PATCH');
  await f.getByRole('button', { name: 'حفظ الموعد' }).click();
  if ((await resp).status() !== 200) throw new Error('reschedule failed');
  await T.page.getByText('عُدّل الموعد وأُبلغ الطالب').waitFor();
  await S.page.reload(); await S.app.getByText('السلام عليكم، يوسف').waitFor();
  await myBookings();
  await S.app.getByText(/11:30/).first().waitFor();
});

execSync(process.env.SOON_CMD || 'bash e2e/ci/py.sh google_soon.py', { stdio: 'inherit' });
await step(S.page, 'student: inside the join window «دخول الجلسة» opens the SAME Google Meet', async () => {
  await S.page.reload(); await S.app.getByText('السلام عليكم، يوسف').waitFor();
  await S.app.getByRole('button', { name: 'الدخول للجلسة' }).first().click();
  await S.app.getByText('جلسة حفظ — سورة الملك').waitFor();
  const popup = S.ctx.waitForEvent('page');
  await S.app.getByRole('button', { name: 'دخول الجلسة' }).click();
  const p = await popup; await p.waitForLoadState();
  if (p.url() !== meet) throw new Error(`opened ${p.url()} instead of ${meet}`);
});
await S.page.screenshot({ path: out + '/google-student.png', fullPage: true });

await step(T.page, 'teacher cancels: the student sees the cancellation', async () => {
  await T.page.reload(); await T.app.getByText('مرحبًا، الشيخ عبدالرحمن السالم').waitFor(); await sched();
  await T.app.getByRole('button', { name: 'إلغاء الجلسة' }).first().click();
  await T.page.getByRole('button', { name: 'إلغاء الجلسة' }).last().click();
  await T.page.getByText('أُلغيت الجلسة').first().waitFor();
  await S.page.reload(); await S.app.getByText('السلام عليكم، يوسف').waitFor();
  await myBookings();
  await S.app.getByText('السابقة والملغاة').waitFor();
  await S.app.getByRole('button', { name: /الشيخ عبدالرحمن السالم/ }).first().click();
  await S.app.getByText('أُلغي هذا الحجز', { exact: false }).waitFor();
});

console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no page errors');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails || errs.length ? 1 : 0; await b.close();
