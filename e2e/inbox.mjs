// In-app notifications (pack prompt 17): an event reaches the right person once, the bell shows the unread count,
// the inbox opens the related item and marks it read. node e2e/inbox.mjs <shots-dir> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0; const errs = [];
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${out}/inbox-fail-${name.replace(/\W+/g, '_')}.png` }); } };
async function session(email) {
  const page = await (await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' })).newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errs.push(e.message));
  const app = page.locator('main#scr');
  await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.locator('#lg-email').fill(email); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  return { page, app };
}
const call = (p, method, path, body) => p.evaluate(async ([m, u, bd]) => {
  const csrf = (await (await fetch('/api/v1/auth/csrf', { credentials: 'include' })).json()).csrfToken;
  const r = await fetch(u, { method: m, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf }, body: bd ? JSON.stringify(bd) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, '/api/v1/' + path, body]);

const S = await session('sara@halqa.app'); await S.app.getByText('السلام عليكم، سارة').waitFor();
const T = await session('teacher@halqa.app'); await T.app.getByText(/مرحبًا،/).waitFor();
const title = `واجب الإشعار ${Date.now() % 100000}`;
await step(T.page, 'teacher assigns a task', async () => {
  const me = await call(S.page, 'GET', 'me');
  const r = await call(T.page, 'POST', 'assignments', { student: me.body.id, kind: 'tajweed', title, surah: 86, ayah_from: 1, ayah_to: 5, due_at: new Date(Date.now() + 2 * 864e5).toISOString() });
  if (r.status !== 201) throw new Error(`assign ${r.status}`);
});
await step(S.page, 'the student sees an unread badge, opens the inbox and the task', async () => {
  await S.page.reload(); await S.app.getByText('السلام عليكم، سارة').waitFor();
  const bell = S.app.getByRole('button', { name: /الإشعارات، \d+ غير مقروءة/ }); await bell.waitFor(); await bell.click();
  await S.app.getByText('واجب جديد من معلمك').first().waitFor();
  await S.app.getByRole('button', { name: new RegExp(title) }).first().click();
  await S.app.getByText(title).first().waitFor();
});
await step(S.page, 'opening marks it read; no duplicates', async () => {
  // The mark-read request may still be on its way after the tap: poll briefly.
  let mine = [];
  for (let i = 0; i < 25; i++) {
    mine = (await call(S.page, 'GET', 'notifications')).body.results.filter((x) => x.body.includes(title));
    if (mine.length === 1 && mine[0].read_at) break;
    await S.page.waitForTimeout(200);
  }
  if (mine.length !== 1 || !mine[0].read_at) throw new Error(JSON.stringify(mine));
});
await step(T.page, 'the teacher did not get the student notification', async () => {
  const n = await call(T.page, 'GET', 'notifications');
  if (n.body.results.some((x) => x.body.includes(title))) throw new Error('leaked to teacher');
});
await S.page.screenshot({ path: out + '/inbox.png', fullPage: true });
if (errs.length) { fails++; console.log('page errors:', errs); }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0; await b.close();
