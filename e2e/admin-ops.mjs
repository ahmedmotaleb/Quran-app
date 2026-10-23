// Admin operations (pack prompt 36) on the Students list: CSV export, assign a teacher, add to a course, in-app
// message, saved views (built-in and own), archive → «المؤرشفون» → restore.
//   node e2e/admin-ops.mjs <shots> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { readFileSync } from 'node:fs';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo', acceptDownloads: true });
const page = await ctx.newPage(); page.setDefaultTimeout(10000);
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${out}/ops-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const bar = () => page.getByRole('toolbar', { name: 'إجراءات على المحدد' });
const dialog = () => page.getByRole('dialog').last();
const pick = async (...names) => { for (const n of names) await page.getByRole('checkbox', { name: `تحديد ${n}` }).check(); };
const run = async (action, fill) => {
  await bar().getByRole('button', { name: action, exact: true }).click();
  await fill?.(dialog());
  const resp = page.waitForResponse((r) => r.url().includes('/bulk-action') && r.request().method() === 'POST');
  await dialog().locator('button[type=submit]').click();
  await resp;  // a toast left over from the previous action must not count as this one's result
};
// After an action the list reloads; wait for the network so the next selection is not lost mid-refresh.
const settle = async () => { const r = page.getByRole('dialog').filter({ hasText: 'نتيجة' }); await page.waitForLoadState('networkidle');
  if (await r.count()) await r.getByRole('button', { name: 'تم' }).click(); await page.waitForLoadState('networkidle'); };

await page.goto(BASE + '#/admin');
await page.locator('#ad-email').fill('admin@halqa.app'); await page.locator('#ad-pw').fill('halqa123');
await page.getByRole('button', { name: 'دخول' }).click();
await page.getByText(/بيانات حقيقية/).waitFor();
await page.getByRole('navigation', { name: 'التنقل في لوحة الإدارة' }).getByRole('button', { name: /^الطلاب/ }).click();
await page.getByRole('button', { name: 'يوسف أحمد', exact: true }).waitFor();

await step('1. export the filtered list as an Arabic CSV', async () => {
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'تصدير النتائج' }).click();
  const d = await dl;
  if (!/^halqa-users-\d{8}-\d{4}\.csv$/.test(d.suggestedFilename())) throw new Error('name ' + d.suggestedFilename());
  const text = readFileSync(await d.path(), 'utf8');
  if (!text.startsWith('﻿الرقم,الاسم,البريد') || !text.includes('يوسف أحمد') || !text.includes('سارة أحمد')) throw new Error('csv ' + text.slice(0, 80));
  if (text.includes('parent@halqa.app')) throw new Error('parents in the students export');
});
await step('2. assign a teacher to two students (one already has them)', async () => {
  await pick('يوسف أحمد', 'سارة أحمد');
  await run('تعيين معلم', async (d) => {
    await d.locator('button[type=submit]').click();
    await d.getByText('أكمل: المعلم.').waitFor();
    await d.getByLabel('المعلم').selectOption({ label: 'الشيخ خالد العمري' });
  });
  await page.getByText(/تم تنفيذ الإجراء على/).first().waitFor();
  await settle();
  await page.getByRole('row').filter({ hasText: 'سارة أحمد' }).getByText('الشيخ خالد العمري', { exact: false }).waitFor();
});
await step('3. add both to a course; already-enrolled are skipped, not failed', async () => {
  await pick('يوسف أحمد', 'سارة أحمد');
  await run('إضافة إلى دورة', async (d) => { await d.getByLabel('الدورة').selectOption({ index: 1 }); });
  await page.getByText(/تم تنفيذ الإجراء على/).first().waitFor();
  if (await page.getByRole('dialog').getByText('تعذر').count()) throw new Error('a record failed');
  await settle();
});
await step('4. in-app message with a recipient count', async () => {
  await pick('يوسف أحمد', 'سارة أحمد');
  await run('رسالة داخل التطبيق', async (d) => {
    await d.getByText('ستصل الرسالة إلى عنصرين', { exact: false }).waitFor();
    await d.getByLabel('العنوان').fill('تنبيه من الإدارة');
    await d.getByLabel('نص الرسالة').fill('الحلقة غدًا بعد العصر بإذن الله');
  });
  await page.getByText('تم تنفيذ الإجراء على عنصرين').waitFor();
  await settle();
});
await step('5. built-in view, then save and delete an own view', async () => {
  await page.getByLabel('العروض').selectOption({ label: 'طلاب بدون معلم' });
  await page.waitForURL(/unlinked=1/);
  await page.getByLabel('العروض').selectOption({ label: 'المؤرشفون' });
  await page.waitForURL(/status=archived/);
  await page.getByRole('button', { name: 'الكل', exact: false }).first().click();
  await page.getByRole('searchbox').fill('سارة');
  await page.waitForURL(/q=/);
  await page.getByRole('button', { name: 'حفظ العرض الحالي' }).click();
  await page.getByLabel('اسم العرض').fill('بحث سارة');
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await page.getByText('حُفظ العرض').waitFor();
  await page.getByRole('searchbox').fill('');
  await page.waitForURL((u) => !decodeURIComponent(u.href).includes('q=سارة'));
  await page.getByLabel('العروض').selectOption({ label: 'بحث سارة' });
  await page.waitForURL((u) => decodeURIComponent(u.href).includes('q=سارة'));
  await page.getByText('إدارة', { exact: true }).click();
  await page.getByRole('button', { name: 'حذف بحث سارة' }).click();
  await page.getByRole('option', { name: 'بحث سارة' }).waitFor({ state: 'detached' });
  await page.getByRole('searchbox').fill('');
  // The search is debounced: wait until it reaches the URL, or the selection made next is reset by it.
  await page.waitForURL((u) => !u.href.includes('q='));
  await page.waitForLoadState('networkidle');
});
await step('6. archive, find under «مؤرشف», restore', async () => {
  await pick('سارة أحمد');
  await run('أرشفة', async (d) => { await d.getByLabel('السبب (يُحفظ في سجل التدقيق)').fill('اختبار الأرشفة'); });
  await page.getByText('تم تنفيذ الإجراء على عنصر واحد').waitFor();
  await page.getByRole('button', { name: 'سارة أحمد', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('group', { name: 'تصفية حسب الحالة' }).getByRole('button', { name: /مؤرشف/ }).click();
  await pick('سارة أحمد');
  await run('تفعيل', (d) => d.locator('#bk-r').fill('تمت مراجعة حالة الطالب'));
  await page.getByText('تم تنفيذ الإجراء على عنصر واحد').last().waitFor();
});
await page.screenshot({ path: out + '/admin-ops.png' });
if (errs.length) { fails++; console.log('FAIL page errors', errs[0]); } else console.log('no page errors');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
