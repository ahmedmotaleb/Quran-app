// Creating tasks (PROMPT 43), against a seeded dev server: node e2e/assigning.mjs <shots-dir> [base-url]
// Teacher: «إضافة مهمة» from the student's file (student fixed), «إرسال مهمة لكل الحلقة» with a per-member result;
// academic admin: «إضافة مهمة» in the student record. Students see the tasks at once.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { execSync } from 'node:child_process';
if (process.env.CIRCLE_CMD) execSync(process.env.CIRCLE_CMD, { stdio: 'inherit' });
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const errs = []; let fails = 0;
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0].replace(/\u001b\[[0-9;]*m/g, '').slice(0, 300)); await p.screenshot({ path: `${out}/assign-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const stamp = Date.now();
async function tasksOf(p, email) {
  const t = (await (await p.request.post(BASE + 'api/v1/auth/login', { data: { identifier: email, password: 'halqa123', client: 'native' } })).json()).token;
  const r = await (await p.request.get(BASE + 'api/v1/assignments', { headers: { Authorization: `Bearer ${t}` } })).json();
  return (r.results ?? r).map((x) => x.title);
}

const tctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
const tp = await tctx.newPage(); tp.setDefaultTimeout(10000); tp.on('pageerror', (e) => errs.push(e.message));
const app = tp.locator('main#scr');
await tp.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
await app.locator('#lg-email').fill('teacher@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
await app.getByText(/^مرحبًا،/).waitFor();
const nav = (n) => tp.getByRole('navigation').getByRole('button', { exact: true, name: n }).click();
const fill = async (from, to, title) => {
  await app.locator('#af-from').fill(from); await app.locator('#af-to').fill(to); await app.locator('#af-title').fill(title);
};

await step(tp, 'teacher: «إضافة مهمة» from the student file does not ask for the student again', async () => {
  await nav('الطلاب'); await app.getByText('يوسف أحمد').first().click();
  await app.getByRole('button', { name: 'إضافة مهمة' }).click();
  await app.getByText('الطالب: يوسف أحمد').waitFor();
  if (await app.locator('#af-stu').count()) throw new Error('student selector shown');
  await fill('1', '5', `من الملف ${stamp}`);
  await app.getByRole('button', { name: /إرسال الواجب إلى يوسف أحمد/ }).click();
  await tp.getByText('أُرسل الواجب إلى يوسف أحمد').waitFor();
  if (!(await tasksOf(tp, 'yousef@halqa.app')).includes(`من الملف ${stamp}`)) throw new Error('student does not see the task');
});
await step(tp, 'teacher: «إرسال مهمة لكل الحلقة» creates one task per member with a result', async () => {
  await tp.getByRole('button', { name: /رجوع/ }).first().click(); // the student file has no tab bar
  await nav('اليوم');
  await app.getByRole('heading', { name: 'حلقاتي' }).waitFor();
  await app.getByText('2 من 2 طالبًا تصلهم المهمة').waitFor();
  await app.getByRole('button', { name: 'إرسال مهمة لكل الحلقة' }).click();
  await app.getByText('الحلقة: حلقة الفجر', { exact: false }).waitFor();
  await fill('1', '3', `للحلقة ${stamp}`);
  await app.getByRole('button', { name: 'إرسال مهمة لكل الحلقة (2)' }).click();
  await tp.getByText('أُرسلت المهمة إلى 2 من طلاب حلقة الفجر').waitFor();
  await tp.getByText('وصلت المهمة إلى كل طلاب الحلقة النشطين.').waitFor();
  for (const e of ['yousef@halqa.app', 'sara@halqa.app']) if (!(await tasksOf(tp, e)).includes(`للحلقة ${stamp}`)) throw new Error('missing for ' + e);
});
await tp.screenshot({ path: out + '/assign-teacher.png' });

const ap = await b.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo' }); ap.setDefaultTimeout(10000); ap.on('pageerror', (e) => errs.push(e.message));
await step(ap, 'admin: «إضافة مهمة» in the student record goes to the linked teacher', async () => {
  await ap.goto(BASE + '#/admin');
  await ap.locator('#ad-email').fill('admin@halqa.app'); await ap.locator('#ad-pw').fill('halqa123');
  await ap.getByRole('button', { name: 'دخول' }).click(); await ap.getByText(/بيانات حقيقية/).waitFor();
  await ap.getByRole('navigation', { name: 'أقسام الإدارة' }).getByRole('button', { name: /^الطلاب/ }).click();
  await ap.getByRole('button', { name: 'سارة أحمد', exact: true }).click();
  await ap.getByRole('button', { name: 'إضافة مهمة' }).click();
  const d = ap.getByRole('dialog').last();
  await d.locator('#tk-f').fill('1'); await d.locator('#tk-to').fill('4'); await d.locator('#tk-ti').fill(`من الإدارة ${stamp}`);
  await d.getByRole('button', { name: 'إرسال المهمة' }).click();
  await ap.getByText('أُرسلت المهمة إلى سارة أحمد').waitFor();
  if (!(await tasksOf(ap, 'sara@halqa.app')).includes(`من الإدارة ${stamp}`)) throw new Error('student does not see the task');
});
if (errs.length) { fails++; console.log('page errors:', errs); }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
