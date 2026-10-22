// Admin dialogs (owner report 23 October 2026): typing in a dialog field used to move focus to the × button after
// every character. Checks continuous typing (archive reason, permanent-delete reason and typed «حذف», promotion
// reason and typed «ترقية»), that × never gets focus, Escape still closes and focus returns to the opener; and that
// «حذف نهائي» is a separate, clearly visible red action next to «أرشفة» when users are selected.
//   node e2e/admin-dialogs.mjs <shots> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await b.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo' }); page.setDefaultTimeout(10000);
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${out}/dialogs-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const dialog = () => page.getByRole('dialog').last();
const bar = () => page.getByRole('toolbar', { name: 'إجراءات على المحدد' });
// Types one key at a time and checks after each key that focus is still in the field and × never had it.
async function typeSteadily(sel, text) {
  await page.evaluate(() => { window.__closeFocused = 0; document.addEventListener('focusin', (e) => { if (e.target?.getAttribute?.('aria-label') === 'إغلاق') window.__closeFocused++; }); });
  await dialog().locator(sel).click();
  for (const ch of text) {
    await page.keyboard.type(ch);
    const id = await page.evaluate(() => document.activeElement?.id);
    if (`#${id}` !== sel) throw new Error(`focus left ${sel} after «${ch}» (now on ${id || document.activeElement})`);
  }
  const v = await dialog().locator(sel).inputValue();
  if (v !== text) throw new Error(`value «${v}» !== «${text}»`);
  if (await page.evaluate(() => window.__closeFocused)) throw new Error('the × button received focus while typing');
}

await page.goto(BASE + '#/admin');
await page.locator('#ad-email').fill('admin@halqa.app'); await page.locator('#ad-pw').fill('halqa123');
await page.getByRole('button', { name: 'دخول' }).click(); await page.getByText(/بيانات حقيقية/).waitFor();
await page.getByRole('navigation', { name: 'أقسام الإدارة' }).getByRole('button', { name: /^الطلاب/ }).click();
await page.getByRole('button', { name: 'يوسف أحمد', exact: true }).waitFor();

await step('selected users: «أرشفة» and «حذف نهائي» are separate red actions in a visible group', async () => {
  await page.getByRole('checkbox', { name: 'تحديد يوسف أحمد' }).check();
  const g = bar().getByRole('group', { name: 'إجراءات خطرة' });
  for (const n of ['أرشفة', 'حذف نهائي']) {
    const btn = g.getByRole('button', { name: n, exact: true });
    await btn.waitFor();
    const box = await btn.boundingBox(); const vp = page.viewportSize();
    if (!box || box.x < 0 || box.x + box.width > vp.width || box.y + box.height > vp.height) throw new Error(`${n} is not on screen`);
  }
  for (const n of ['تفعيل', 'تعطيل']) await bar().getByRole('button', { name: n, exact: true }).waitFor();
});
await step('archive dialog: continuous typing; × never focused; Escape closes and focus returns', async () => {
  const opener = bar().getByRole('button', { name: 'أرشفة', exact: true });
  await opener.click();
  await dialog().getByText('تأكيد الأرشفة').waitFor();
  if (await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'إغلاق') throw new Error('× focused on open');
  await typeSteadily('#bk-r', 'اختبار أرشفة الطالب');
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'detached' });
  if (await page.evaluate(() => document.activeElement?.textContent?.trim()) !== 'أرشفة') throw new Error('focus did not return to «أرشفة»');
});
await step('permanent delete: reason and typed «حذف» accept continuous typing; strong wording', async () => {
  await bar().getByRole('button', { name: 'حذف نهائي', exact: true }).click();
  await dialog().getByText('أنت على وشك حذف حسابًا واحدًا نهائيًا. لا يمكن التراجع عن هذا الإجراء.', { exact: false }).waitFor();
  await dialog().getByRole('button', { name: 'حذف حسابًا واحدًا نهائيًا' }).waitFor();
  await typeSteadily('#bk-r', 'طلب ولي الأمر حذف الحساب');
  await typeSteadily('#bk-c', 'حذف');
  await dialog().getByRole('button', { name: 'إلغاء' }).click();
  await dialog().waitFor({ state: 'detached' });
});
await step('person panel: archive reason (ReasonDialog) and promotion dialog accept continuous typing', async () => {
  await page.getByRole('checkbox', { name: 'تحديد يوسف أحمد' }).uncheck();
  await page.getByRole('button', { name: 'يوسف أحمد', exact: true }).click();
  await dialog().getByRole('button', { name: 'أرشفة الحساب' }).click();
  await typeSteadily('#rs', 'اختبار أرشفة الطالب');
  await page.keyboard.press('Escape'); await page.getByRole('dialog', { name: 'أرشفة الحساب' }).waitFor({ state: 'detached' });
  await dialog().getByRole('button', { name: 'ترقية إلى معلم' }).click();
  await dialog().getByText('سيتم تحويل هذا الحساب', { exact: false }).waitFor();
  await typeSteadily('#pr-r', 'انضم إلى فريق المعلمين');
  await typeSteadily('#pr-c', 'ترقية');
  await page.keyboard.press('Escape'); await page.getByRole('dialog', { name: 'ترقية الحساب إلى معلم' }).waitFor({ state: 'detached' });
});
await step('filter drawer: typing a date keeps focus', async () => {
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /تصفية/ }).first().click();
  const date = dialog().locator('input[type=date]').first();
  await date.click(); await page.keyboard.type('01012026');
  const id = await page.evaluate(() => document.activeElement?.getAttribute('type'));
  if (id !== 'date') throw new Error('focus left the date field');
});
await page.screenshot({ path: out + '/admin-dialogs.png' });
if (errs.length) { fails++; console.log('FAIL page errors', errs[0]); } else console.log('no page errors');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
