// Admin select-all, filter and bulk actions on the Students list (live API).
//   MANY_CMD="bash e2e/ci/py.sh many_students.py" node e2e/admin-bulk.mjs <shots> [base-url]
// Needs 30 test students "طالب تجريبي NN" (26 active, 4 suspended), created by MANY_CMD.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { execSync } from 'node:child_process';
import { trackWrites } from './lib/settle.mjs';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
if (process.env.MANY_CMD) execSync(process.env.MANY_CMD, { stdio: 'inherit' });
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo' });
const page = await ctx.newPage(); page.setDefaultTimeout(10000);
const { settled } = trackWrites(page);
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${out}/bulk-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const api = async (path) => page.evaluate(async (p) => (await fetch('/api/v1/' + p, { credentials: 'include', headers: { 'X-Halqa-Portal': 'admin' } })).json(), path);
const status = () => page.getByRole('status').filter({ hasText: /تم تحديد/ }).first();
const bar = () => page.getByRole('toolbar', { name: 'إجراءات على المحدد' });
const dialog = () => page.getByRole('dialog').last();
const rowBox = (n) => page.getByRole('checkbox', { name: `تحديد طالب تجريبي ${String(n).padStart(2, '0')}` });
const header = () => page.getByRole('checkbox', { name: 'تحديد كل الصفوف الظاهرة' });

await page.goto(BASE + '#/admin');
await page.locator('#ad-email').fill('admin@halqa.app'); await page.locator('#ad-pw').fill('halqa123');
await page.getByRole('button', { name: 'دخول' }).click();
await page.getByText(/بيانات حقيقية/).waitFor();

await step('1. open Students; search narrows on the server and goes in the URL', async () => {
  await page.getByRole('navigation', { name: 'التنقل في لوحة الإدارة' }).getByRole('button', { name: /^الطلاب/ }).click();
  await page.getByRole('searchbox').fill('تجريبي');
  await page.getByText('عرض 1–20 من 30').waitFor();
  if (!page.url().includes('#/admin/students?') || !decodeURIComponent(page.url()).includes('q=تجريبي')) throw new Error('search not in URL: ' + page.url());
});
await step('2. select one student', async () => {
  await rowBox(29).check();
  await status().filter({ hasText: 'تم تحديد 1 عنصر' }).waitFor();
  await bar().getByText('1 محدد').waitFor();
});
await step('3. select the current page; the "all results" offer appears', async () => {
  await header().check();
  await status().filter({ hasText: 'تم تحديد 20 عنصر' }).waitFor();
  await page.getByText('تم تحديد 20 عنصر في هذه الصفحة').waitFor();
  await page.getByRole('button', { name: 'تحديد جميع النتائج الـ 30' }).waitFor();
});
await step('4. deselect one: the header shows a mixed state', async () => {
  await rowBox(29).uncheck();
  await status().filter({ hasText: 'تم تحديد 19 عنصر' }).waitFor();
  if (!(await header().evaluate((e) => e.indeterminate))) throw new Error('header not indeterminate');
});
await step('5. filter active students from the filter drawer; chip shown; selection cleared', async () => {
  await page.getByRole('button', { name: /^تصفية/ }).click();
  await dialog().getByLabel('الحالة').selectOption('active');
  await dialog().getByRole('button', { name: 'تطبيق' }).click();
  await page.getByRole('button', { name: 'إزالة عامل التصفية: نشط' }).waitFor();
  await page.getByText('عرض 1–20 من 26').waitFor();
  if (!page.url().includes('status=active')) throw new Error('filter not in URL');
  if (await bar().count()) throw new Error('selection survived a filter change');
});
await step('6. select all 26 filtered results (server-side, not just this page)', async () => {
  await header().check();
  await page.getByRole('button', { name: 'تحديد جميع النتائج الـ 26' }).click();
  await status().filter({ hasText: 'تم تحديد جميع النتائج (26 عنصر)' }).waitFor();
  await bar().getByText('26 محدد').waitFor();
});
await step('destructive modal: typed confirmation required, and cancelling changes nothing', async () => {
  await bar().getByRole('button', { name: 'أرشفة' }).click();
  await dialog().getByRole('heading', { name: 'تأكيد الأرشفة' }).waitFor();
  await dialog().getByLabel('اكتب حذف للتأكيد').waitFor();
  await dialog().getByRole('button', { name: 'أرشفة 26 عنصرًا' }).click();
  await dialog().getByText('اكتب السبب', { exact: false }).waitFor();          // nothing sent without a reason
  await dialog().getByRole('button', { name: 'إلغاء', exact: true }).click();
  await settled();
  const r = await api('admin/users/counts?role=student');
  if (r.archived !== 0) throw new Error('something was archived');
  await bar().getByText('26 محدد').waitFor();                                // selection kept after cancel
});
await step('7–8. bulk suspend all filtered results after confirming', async () => {
  await bar().getByRole('button', { name: 'تعطيل' }).click();
  await dialog().getByLabel('السبب (يُحفظ في سجل التدقيق)').fill('اختبار الإجراءات الجماعية');
  await dialog().getByRole('button', { name: 'تعطيل 26 عنصرًا' }).click();
  await page.getByText('تم تنفيذ الإجراء على 26 عنصرًا').waitFor();
});
await step('9. the table refreshes from the server', async () => {
  await page.getByText('لا توجد نتائج مطابقة.').waitFor();                    // no active test students left
});
await step('10. selection is cleared', async () => {
  if (await bar().count()) throw new Error('toolbar still shown');
});
await step('11. persisted after reload; filter kept in the URL; audit recorded', async () => {
  await page.reload();
  await page.getByRole('button', { name: 'إزالة عامل التصفية: نشط' }).waitFor();
  await page.getByText('لا توجد نتائج مطابقة.').waitFor();
  await page.getByRole('button', { name: 'إزالة عامل التصفية: نشط' }).click();
  await page.getByText('عرض 1–20 من 30').waitFor();
  const r = await api('admin/users?role=student&q=' + encodeURIComponent('تجريبي') + '&status=suspended&page_size=100');
  if (r.count !== 30) throw new Error(`suspended ${r.count}`);
  const a = await api('admin/audit?action=admin.bulk_suspend');
  if (!a.results?.length || a.results[0].data.success !== 26) throw new Error('no audit event');
});
await step('partial result: nothing changed is reported with the reason', async () => {
  await rowBox(29).check(); await rowBox(28).check();
  await bar().getByRole('button', { name: 'تعطيل' }).click();                // both already suspended: skipped
  await dialog().getByLabel('السبب (يُحفظ في سجل التدقيق)').fill('مرة ثانية');
  await dialog().getByRole('button', { name: 'تعطيل عنصرين' }).click();
  await dialog().getByText('تم تنفيذ الإجراء على 0 من عنصرين').waitFor();
  await dialog().getByText('عنصرين في الحالة المطلوبة بالفعل', { exact: false }).waitFor();
  await dialog().getByText('في هذه الحالة بالفعل.', { exact: false }).first().waitFor();
  await page.screenshot({ path: out + '/bulk-result.png' });
  await dialog().getByRole('button', { name: 'تم' }).click();
});
await step('bulk delete never removes content with history: published courses are refused with reasons', async () => {
  await page.getByRole('navigation', { name: 'التنقل في لوحة الإدارة' }).getByRole('button', { name: /^المحاضرات/ }).click();
  await page.getByText('عرض 1–3 من 3').waitFor();
  await header().check();
  await bar().getByRole('button', { name: 'حذف المحدد' }).click();
  await dialog().getByRole('heading', { name: 'تأكيد الحذف' }).waitFor();
  await dialog().getByText('لا يمكن التراجع عن هذا الإجراء', { exact: false }).waitFor();
  await dialog().getByRole('button', { name: 'حذف 3 عناصر' }).click();
  await dialog().getByText('تم تنفيذ الإجراء على 0 من 3 عناصر').waitFor();
  await dialog().getByText('تعذر تنفيذ الإجراء على 3 عناصر').waitFor();
  await dialog().getByText('تُحذف المسودات فقط', { exact: false }).first().waitFor();
  await dialog().getByRole('button', { name: 'تم' }).click();
  await bar().getByText('3 محدد').waitFor();                                  // the refused rows stay selected to inspect
  if ((await api('admin/courses')).count !== 3) throw new Error('a course was deleted');
  await bar().getByRole('button', { name: 'إلغاء التحديد' }).click();
});
await step('mobile width: cards with the same selection', async () => {
  await page.goBack();                                                       // browser back returns to Students with its filters
  await page.getByRole('heading', { name: 'الطلاب', level: 1 }).waitFor();
  if (!decodeURIComponent(page.url()).includes('q=تجريبي')) throw new Error('back lost the filters: ' + page.url());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('list', { name: /النتائج/ }).waitFor();
  await rowBox(25).check();
  await bar().getByText(/^\d+ محدد$/).waitFor();
  await page.screenshot({ path: out + '/bulk-mobile.png' });
});
if (errs.length) { fails++; console.log('FAIL page errors', errs[0]); }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
