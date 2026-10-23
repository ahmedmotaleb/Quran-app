// «التقارير» (PROMPT 46): academy KPIs and teacher workload from the server, each number with its definition, empty
// ratios as «لا بيانات كافية», teacher/date filters, CSV export, and a phone layout without page-level scrolling.
//   node e2e/reports.mjs <shots> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { readFileSync } from 'node:fs';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const errs = []; let fails = 0;
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0].slice(0, 300)); await p.screenshot({ path: `${out}/reports-fail-${name.replace(/\W+/g, '_')}.png`, fullPage: true }); } };
async function open(viewport) {
  const ctx = await b.newContext({ viewport, timezoneId: 'Africa/Cairo', acceptDownloads: true });
  const p = await ctx.newPage(); p.setDefaultTimeout(10000); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(BASE + '#/admin');
  await p.locator('#ad-email').fill('admin@halqa.app'); await p.locator('#ad-pw').fill('halqa123');
  await p.getByRole('button', { name: 'دخول' }).click(); await p.getByText(/بيانات حقيقية/).waitFor();
  return p;
}
const p = await open({ width: 1280, height: 900 });
const kpiReq = p.waitForResponse((r) => r.url().includes('/admin/kpis'));
await p.getByRole('navigation', { name: 'التنقل في لوحة الإدارة' }).getByRole('button', { name: 'التقارير' }).click();
await kpiReq;

await step(p, 'KPI groups with numbers, what they count and their definitions', async () => {
  await p.getByRole('heading', { level: 1, name: 'التقارير' }).waitFor();
  for (const g of ['الحضور والانضباط', 'الجلسات والحلقات', 'التعلّم والمراجعة', 'المستخدمون']) await p.getByRole('region', { name: g }).waitFor();
  const att = p.getByRole('article', { name: 'نسبة الحضور' });
  await att.getByText(/لم يُسجَّل \d+/).waitFor();
  await att.getByText(/\(حضر \+ متأخر\) ÷/).waitFor();
  await p.getByRole('article', { name: 'طلاب نشطون' }).getByText(/^\d+$/).waitFor();
  await p.getByText(/الفترة \d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2} بتوقيت القاهرة/).waitFor();
});
await p.screenshot({ path: out + '/reports-desktop.png', fullPage: true });

await step(p, 'teacher workload table lists the active teachers', async () => {
  const t = p.getByRole('region', { name: 'عبء عمل المعلمين' });
  await t.getByRole('columnheader', { name: 'متأخرة +48 س' }).waitFor();
  if ((await t.getByRole('row').count()) < 2) throw new Error('no teacher rows');
});

await step(p, 'filtering by teacher narrows the table and flags metrics the filter does not change', async () => {
  const sel = p.getByRole('combobox', { name: 'المعلم', exact: true });
  const first = await sel.locator('option').nth(1).getAttribute('value');
  await Promise.all([p.waitForResponse((x) => x.url().includes(`/admin/teacher-workload?`) && x.url().includes(`teacher=${first}`)), sel.selectOption(first)]);
  const rows = p.getByRole('region', { name: 'عبء عمل المعلمين' }).getByRole('row');
  await p.waitForFunction(() => document.querySelectorAll('[aria-label="عبء عمل المعلمين"] tbody tr').length === 1);
  if ((await rows.count()) !== 2) throw new Error('expected one teacher');
  await p.getByRole('article', { name: 'طلاب نشطون' }).getByText('(لا يتأثر بالمرشح المختار)').waitFor();
});

await step(p, 'a period with no data shows «لا بيانات كافية», never 0%', async () => {
  await p.getByRole('button', { name: 'آخر 30 يومًا' }).click();
  await p.getByLabel('من', { exact: true }).fill('2020-01-01'); await p.getByLabel('إلى', { exact: true }).fill('2020-01-31');
  await p.getByRole('article', { name: 'امتلاء الجلسات' }).getByText('لا بيانات كافية').waitFor();
  await p.getByRole('article', { name: 'نسبة الحضور' }).getByText('لا بيانات كافية').waitFor();
  await p.getByRole('button', { name: 'آخر 30 يومًا' }).click();
});

await step(p, 'CSV export downloads the workload table (UTF-8 BOM, Arabic headers)', async () => {
  const dl = p.waitForEvent('download');
  await p.getByRole('button', { name: 'تصدير CSV' }).click();
  const d = await dl; const f = `${out}/workload.csv`; await d.saveAs(f);
  const text = readFileSync(f, 'utf8');
  if (!d.suggestedFilename().startsWith('teacher-workload-') || !text.startsWith('﻿المعلم,')) throw new Error(d.suggestedFilename() + ' ' + text.slice(0, 40));
});

const m = await open({ width: 390, height: 844 });
await step(m, 'phone: reports open from the drawer and the page does not scroll sideways', async () => {
  await m.getByRole('button', { name: 'فتح القائمة' }).click();
  await m.getByRole('dialog', { name: 'قائمة لوحة الإدارة' }).getByRole('button', { name: 'التقارير' }).click();
  await m.getByRole('article', { name: 'نسبة الحضور' }).waitFor();
  await m.getByRole('region', { name: 'جدول عبء العمل (مرّر أفقيًا)' }).waitFor();
  const [sw, cw] = await m.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  if (sw > cw + 1) throw new Error(`page scrolls horizontally: ${sw} > ${cw}`);
});
await m.screenshot({ path: out + '/reports-phone.png', fullPage: true });

console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no page errors');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails || errs.length ? 1 : 0; await b.close();
