// Progress consistency (pack prompts 11–14): what each screen shows equals the server Progress API, for several
// learners, and the parent/teacher views show the same numbers as the student's own.
//   node e2e/progress.mjs <shots-dir> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0; const errs = [];
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${out}/prog-fail-${name.replace(/\W+/g, '_')}.png` }); } };
async function session(email) {
  const page = await (await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' })).newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errs.push(e.message));
  const app = page.locator('main#scr');
  await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.locator('#lg-email').fill(email); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  return { page, app };
}
const nav = (p, n) => p.getByRole('navigation').getByRole('button', { exact: true, name: n }).click();
const getJson = (p, path) => p.evaluate(async (u) => (await fetch(u, { credentials: 'include' })).json(), '/api/v1/' + path);
const memo = (m) => (m.assigned_ayahs ? `${m.accepted_ayahs} من ${m.assigned_ayahs} آية` : '—');

const api = {};
for (const [email, first] of [['yousef@halqa.app', 'يوسف'], ['sara@halqa.app', 'سارة']]) {
  const S = await session(email);
  await step(S.page, `${first}: progress screen equals the API`, async () => {
    await S.app.getByText(`السلام عليكم، ${first}`).waitFor();
    await nav(S.page, 'تقدمي'); await S.app.getByText('كيف تُحسب هذه الأرقام؟').waitFor();
    const p = await getJson(S.page, 'progress/me'); api[first] = p;
    await S.app.getByText(memo(p.memorization), { exact: true }).waitFor();
    await S.app.getByText(`${p.review.due_today} اليوم`, { exact: true }).waitFor();
    await S.app.getByText(`${p.practice.submissions} تسجيل · ${p.practice.reviewed} قيّمه المعلم`).waitFor();
    await S.app.getByText(`${p.learning.lessons_completed} درس`, { exact: true }).waitFor();
  });
  await S.page.screenshot({ path: `${out}/prog-${first}.png`, fullPage: true });
  await S.page.context().close();
}
const P = await session('parent@halqa.app');
await step(P.page, 'parent sees each child with the same numbers', async () => {
  for (const first of ['يوسف', 'سارة']) {
    await P.app.getByRole('tab', { name: new RegExp(first) }).click();
    await P.app.getByText('التقدّم في آخر 30 يومًا').waitFor();
    await P.app.getByText(memo(api[first].memorization), { exact: true }).waitFor();
    await P.app.getByText(`${api[first].practice.submissions} تسجيل · ${api[first].practice.reviewed} قيّمه المعلم`).waitFor();
  }
});
await P.page.screenshot({ path: `${out}/prog-parent.png`, fullPage: true });
const T = await session('teacher@halqa.app');
await step(T.page, 'teacher sees the same numbers in the student file', async () => {
  await T.app.getByText(/مرحبًا،/).waitFor();
  await nav(T.page, 'الطلاب'); await T.app.getByRole('button', { name: /يوسف أحمد/ }).first().click();
  await T.app.getByText('التقدّم (آخر 30 يومًا)').waitFor();
  await T.app.getByText(memo(api['يوسف'].memorization), { exact: true }).waitFor();
});
await T.page.screenshot({ path: `${out}/prog-teacher.png`, fullPage: true });
if (errs.length) { fails++; console.log('page errors:', errs); }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0; await b.close();
