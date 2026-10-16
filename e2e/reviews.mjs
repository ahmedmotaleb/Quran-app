// Spaced repetition + Today plan (pack prompts 15–16), against a seeded dev server:
//   DUE_CMD='<shell that sets every review schedule due today>' node e2e/reviews.mjs <shots-dir> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { execSync } from 'node:child_process';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0; const errs = [];
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${out}/rev-fail-${name.replace(/\W+/g, '_')}.png` }); } };
async function session(email) {
  const page = await (await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' })).newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errs.push(e.message));
  const app = page.locator('main#scr');
  await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.locator('#lg-email').fill(email); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  return { page, app };
}
const call = (p, method, path, body, headers = {}) => p.evaluate(async ([m, u, bd, h]) => {
  const csrf = (await (await fetch('/api/v1/auth/csrf', { credentials: 'include' })).json()).csrfToken;
  const r = await fetch(u, { method: m, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf, ...h }, body: bd ? JSON.stringify(bd) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, '/api/v1/' + path, body, headers]);
const nav = (p, n) => p.getByRole('navigation').getByRole('button', { exact: true, name: n }).click();

const T = await session('teacher@halqa.app'); await T.app.getByText(/مرحبًا،/).waitFor();
const S = await session('yousef@halqa.app'); await S.app.getByText('السلام عليكم، يوسف').waitFor();
let taskId = 0;
await step(T.page, 'teacher accepts a memorization → a review schedule starts', async () => {
  const me = await call(S.page, 'GET', 'me');
  const t = await call(T.page, 'POST', 'assignments', { student: me.body.id, kind: 'hifz', title: 'حفظ أول الملك', surah: 67, ayah_from: 1, ayah_to: 4, due_at: new Date(Date.now() + 864e5).toISOString() });
  if (t.status !== 201) throw new Error(`assign ${t.status} ${JSON.stringify(t.body)}`);
  taskId = t.body.id;
  const media = await S.page.evaluate(async () => {
    const csrf = (await (await fetch('/api/v1/auth/csrf', { credentials: 'include' })).json()).csrfToken;
    const fd = new FormData(); fd.append('file', new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(2000).fill(0)])], { type: 'audio/webm' }), 'r.webm'); fd.append('duration_seconds', '40');
    return (await (await fetch('/api/v1/media/recitations', { method: 'POST', credentials: 'include', headers: { 'X-CSRFToken': csrf }, body: fd })).json()).id;
  });
  const sub = await call(S.page, 'POST', `assignments/${taskId}/submissions`, { media }, { 'Idempotency-Key': `e2e-${Date.now()}` });
  const fb = await call(T.page, 'POST', `submissions/${sub.body.id}/feedback`, { score_hifz: 5, score_tajweed: 5, score_fluency: 5, decision: 'accept', general: 'أحسنت', notes: [] });
  if (fb.status !== 201) throw new Error(`feedback ${fb.status}`);
  const sch = await call(S.page, 'GET', 'review-schedules');
  if (!sch.body.results.some((x) => x.ayah_from === 1 && x.ayah_to === 4)) throw new Error('no schedule');
});
await step(S.page, 'when due, the review appears once in خطة اليوم', async () => {
  execSync(process.env.DUE_CMD, { stdio: 'inherit' });
  await S.page.reload(); await S.app.getByText('خطة اليوم').waitFor();
  // Count inside the plan only: Home also has a separate "today's review" card that may show the same task.
  const plan = () => S.app.locator('section[aria-labelledby="today-h"]');
  const item = plan().getByRole('button', { name: /مراجعة: سورة .* 1–4/ });
  await item.waitFor();
  await S.page.reload(); await S.app.getByText('خطة اليوم').waitFor();
  if (await plan().getByRole('button', { name: /مراجعة: سورة .* 1–4/ }).count() !== 1) throw new Error('duplicated in the plan');
  await S.app.getByRole('button', { name: 'كيف تُرتّب الخطة؟' }).click(); await S.app.getByText(/واجبات المعلم المتأخرة أولًا/).waitFor();
});
await S.page.screenshot({ path: out + '/rev-today.png', fullPage: true });
await step(T.page, 'teacher sees the schedule and overrides the date with a reason', async () => {
  await T.page.reload(); await T.app.getByText(/مرحبًا،/).waitFor();
  await nav(T.page, 'الطلاب'); await T.app.getByRole('button', { name: /يوسف أحمد/ }).first().click();
  await T.app.getByText('جدول المراجعة').waitFor();
  await T.app.getByRole('button', { name: 'تعديل الموعد' }).first().click();
  const d = new Date(Date.now() + 3 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
  await T.app.locator('input[type=date]').fill(d); await T.app.getByLabel('السبب').fill('سفر الطالب');
  await T.app.getByRole('button', { name: 'حفظ', exact: true }).click(); await T.page.getByText('حُفظ التعديل').waitFor();
  await T.app.getByText(new RegExp(`التالية ${d}`)).first().waitFor();
  await T.app.getByRole('button', { name: /السجل/ }).first().click(); await T.app.getByText(/سفر الطالب/).waitFor();
});
await T.page.screenshot({ path: out + '/rev-teacher.png', fullPage: true });
if (errs.length) { fails++; console.log('page errors:', errs); }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0; await b.close();
