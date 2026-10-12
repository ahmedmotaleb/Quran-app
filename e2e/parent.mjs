// Live parent app: linked children only, real tasks/feedback/attendance, no audio.
// Run like e2e/live.mjs. Pass REVOKE_CMD to run between phases (revokes Sara's guardian link).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { execSync } from 'node:child_process';
const out = process.argv[2]; const BASE = process.argv[3] || 'http://localhost:5174/';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await b.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' }); page.setDefaultTimeout(8000);
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const audio = []; page.on('request', (r) => { if (r.url().includes('/media/')) audio.push(r.url()); });
const app = page.locator('main#scr'); let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${out}/fail-${name.replace(/\W+/g, '_')}.png` }); } };
await page.goto(BASE);
await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
await app.locator('#lg-email').fill('parent@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
await step('parent sees both linked children, no sample banner', async () => {
  await app.getByRole('tab', { name: /يوسف/ }).waitFor(); await app.getByRole('tab', { name: /سارة/ }).waitFor();
  if (await page.getByText('محتوى تجريبي').count()) throw new Error('sample banner shown');
});
await step('Yousef: real tasks, attendance, latest feedback', async () => {
  await app.getByRole('tab', { name: /يوسف/ }).click();
  await app.getByText('تطبيق أحكام النون الساكنة والتنوين').waitFor();
  await app.getByText('حضر').first().waitFor();
  await app.getByText(/أحدث تقييم/).waitFor();
  await app.getByText('تسجيلات التلاوة خاصة بالطالب ومعلمه ولا تظهر هنا.').waitFor();
});
await page.screenshot({ path: out + '/p1-yousef.png', fullPage: true });
await step('Sara: her own task only', async () => {
  await app.getByRole('tab', { name: /سارة/ }).click();
  await app.getByText('حفظ سورة الطارق').waitFor();
  if (await app.getByText('تطبيق أحكام النون الساكنة والتنوين').count()) throw new Error("brother's task leaked into Sara's view");
});
await step('no audio requested by parent app', async () => { if (audio.length) throw new Error(audio.join(',')); });
if (process.env.REVOKE_CMD) {
  execSync(process.env.REVOKE_CMD, { stdio: 'ignore' });
  await step('revoked link hides the child after reload', async () => {
    await page.reload();
    await app.getByRole('tab', { name: /يوسف/ }).waitFor();
    if (await app.getByRole('tab', { name: /سارة/ }).count()) throw new Error('revoked child still visible');
    if (await app.getByText('حفظ سورة الطارق').count()) throw new Error('revoked child data visible');
  });
}
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no page errors');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0; await b.close();
