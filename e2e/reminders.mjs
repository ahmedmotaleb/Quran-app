// «تذكيرات القرآن الكريم»: the student sets reminder hours and quiet hours in «حسابي» (a reminder inside quiet hours is
// refused with a clear message); tapping a reading reminder opens the Mushaf; with push not ready on the server the
// «فعّل إشعارات الحلقة» sheet is not shown (nothing to enable).   NOTE_CMD="bash e2e/ci/py.sh reminder_note.py" node e2e/reminders.mjs <shots> [base]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { execSync } from 'node:child_process';
import { pickWho } from './lib/who.mjs';
if (process.env.NOTE_CMD) execSync(process.env.NOTE_CMD, { stdio: 'inherit' });
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
const page = await ctx.newPage(); page.setDefaultTimeout(10000);
const app = page.locator('main#scr');
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${out}/rem-fail-${name.replace(/\W+/g, '_')}.png` }); } };
await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
await pickWho(app, 'yousef@halqa.app'); await app.locator('#lg-email').fill('yousef@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
await app.getByText('السلام عليكم، يوسف').waitFor();

await step('push not ready on this server: no «فعّل إشعارات الحلقة» sheet', async () => {
  const ready = await (await page.request.get(BASE + 'api/ready')).json();
  await page.waitForTimeout(2500);
  const shown = await page.getByTestId('reminder-sheet').count();
  if (ready.features?.push !== 'ready' && shown) throw new Error('sheet shown although push is not ready');
});
await step('tapping a reading reminder opens the Mushaf', async () => {
  await app.getByRole('button', { name: /الإشعارات/ }).first().click();
  await app.getByText('وردك اليومي').first().click();
  await app.getByRole('button', { name: 'تكبير الخط' }).waitFor();                      // the Mushaf reader
});
await step('«حسابي»: reminder hours and quiet hours, saved by the server', async () => {
  await page.goto(BASE); await app.getByText('السلام عليكم، يوسف').waitFor();
  await page.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  const sec = app.getByRole('region', { name: 'تذكيرات القرآن الكريم' });
  await sec.getByText('بتوقيت منطقتك الزمنية', { exact: false }).waitFor();
  await sec.getByLabel('وقت تذكير ورد القراءة').selectOption('8');
  await page.getByText('حُفظت التذكيرات').waitFor();
  await sec.getByLabel('وقت تذكير ورد القراءة').selectOption('3');                      // 03:00 is inside 23:00–07:00
  await sec.getByText('هذا الوقت ضمن ساعات الهدوء', { exact: false }).waitFor();
  if ((await sec.getByLabel('وقت تذكير ورد القراءة').inputValue()) !== '8') throw new Error('refused hour kept');
  await sec.getByRole('checkbox', { name: /الحفظ/ }).uncheck();
  await page.waitForTimeout(500);
  await page.reload(); await page.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  const s2 = app.getByRole('region', { name: 'تذكيرات القرآن الكريم' });
  if ((await s2.getByLabel('وقت تذكير ورد القراءة').inputValue()) !== '8') throw new Error('hour not saved');
  if (await s2.getByRole('checkbox', { name: /الحفظ/ }).isChecked()) throw new Error('hifz still on');
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('sideways scroll');
  await page.screenshot({ path: out + '/reminders-settings.png', fullPage: true });
});
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
