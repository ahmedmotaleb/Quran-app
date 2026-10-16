// Live admin settings (pack prompt 08), against a seeded dev server: node e2e/admin-settings.mjs <shots-dir> [base-url]
// A safe change persists and is audited; a sensitive change needs the password; the learner app follows it.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { trackWrites } from './lib/settle.mjs';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await b.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo' }); page.setDefaultTimeout(10000);
const { settledReload } = trackWrites(page);
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${out}/settings-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const nav = (name) => page.getByRole('navigation', { name: 'أقسام الإدارة' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
const dialog = () => page.getByRole('dialog').last();

await page.goto(BASE + '#/admin');
await page.locator('#ad-email').fill('admin@halqa.app'); await page.locator('#ad-pw').fill('halqa123');
await page.getByRole('button', { name: 'دخول' }).click(); await page.getByText(/بيانات حقيقية/).waitFor();

await step('a safe change saves, persists after reload and is audited', async () => {
  await nav('الإعدادات'); await page.locator('#st-cancel_hours').fill('24');
  await page.getByText('1 تغيير غير محفوظ').waitFor();
  await page.getByRole('button', { name: 'حفظ التغييرات' }).click(); await page.getByText(/آخر حفظ/).waitFor();
  await settledReload(); await nav('الإعدادات');
  if (await page.locator('#st-cancel_hours').inputValue() !== '24') throw new Error('not persisted');
  await page.getByRole('cell', { name: 'تعديل الإعدادات' }).first().waitFor(); await page.getByText('cancel_hours: 12 → 24').first().waitFor();
});
await step('invalid values are rejected beside the field', async () => {
  await page.locator('#st-booking_horizon_days').fill('0'); await page.getByRole('button', { name: 'حفظ التغييرات' }).click();
  await page.getByText('أدخل رقمًا بين 1 و 90').waitFor(); await page.getByRole('button', { name: 'تراجع' }).click();
});
await step('a sensitive change needs the password', async () => {
  await page.getByRole('switch', { name: 'التسجيل المفتوح' }).click();
  await page.getByText(/يتطلب كلمة المرور/).waitFor(); await page.getByRole('button', { name: 'حفظ التغييرات' }).click();
  await dialog().locator('#st-pw').fill('wrong-password-123'); await dialog().getByRole('button', { name: 'تأكيد وحفظ' }).click();
  await dialog().getByText('كلمة المرور مطلوبة أو غير صحيحة.').waitFor();
  await dialog().locator('#st-pw').fill('halqa123'); await dialog().getByRole('button', { name: 'تأكيد وحفظ' }).click();
  await page.getByText(/آخر حفظ/).waitFor();
});
await step('the learner app follows the setting (sign-up closed)', async () => {
  const p2 = await b.newPage(); await p2.goto(BASE);
  await p2.getByRole('button', { name: 'تخطَّ', exact: true }).click();
  await p2.getByText('التسجيل مغلق حاليًا').waitFor();
  const r = await p2.request.post(BASE + 'api/v1/auth/register', { data: { full_name: 'تجربة', email: `x${Date.now()}@example.com`, password: 'Some-Password-2026', client: 'native' } });
  if (r.status() !== 403) throw new Error(`register ${r.status()}`);
  await p2.close();
});
await step('restore sign-up (password again); the app shows sign-up', async () => {
  await page.getByRole('switch', { name: 'التسجيل المفتوح' }).click(); await page.getByRole('button', { name: 'حفظ التغييرات' }).click();
  await dialog().locator('#st-pw').fill('halqa123'); await dialog().getByRole('button', { name: 'تأكيد وحفظ' }).click(); await page.getByText(/آخر حفظ/).waitFor();
  const p2 = await b.newPage(); await p2.goto(BASE); await p2.getByRole('button', { name: 'تخطَّ', exact: true }).click();
  await p2.getByRole('button', { name: 'أنشئ حساب طالب' }).waitFor(); await p2.close();
});
await page.screenshot({ path: out + '/settings.png', fullPage: true });
if (errs.length) { fails++; console.log('page errors:', errs); }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
