// «فعّل تذكيرات القرآن الكريم» bottom sheet on the student's home (production build with the service worker).
// The server's push config is answered as "ready" here (a test public key; the local server has no VAPID keys), so
// the sheet's own behaviour is checked: it appears only after sign-in on the home screen; «ليس الآن» hides it for
// 7 days; a refused browser permission shows the device-settings steps once and never asks again; the browser
// permission is requested only from «تفعيل الإشعارات»; iPhone outside the Home Screen gets the install steps.
//   node e2e/reminder-sheet.mjs <shots> [liveUrl=http://localhost:4175/]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { pickWho } from './lib/who.mjs';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:4175/').replace(/\/?$/, '/');
const KEY = 'BB8EPsDPPBwbaQwEjtC4LR2ZtMRvq5UzzE7N-3fnJITrsyMAC4GK4SIqUDXbUWFUXDRmqCynFc1XofAA5dx3MuM'; // test key, not production
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${out}/remsheet-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

async function open({ ua, permission = 'default' } = {}) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo', ...(ua ? { userAgent: ua, isMobile: true, hasTouch: true } : {}) });
  await ctx.addInitScript((perm) => {
    window.__asked = 0;
    if (window.Notification) {
      Object.defineProperty(Notification, 'permission', { get: () => window.__perm ?? perm, configurable: true });
      Notification.requestPermission = async () => { window.__asked++; window.__perm = 'denied'; return 'denied'; };
    }
  }, permission);
  // iPhone Safari outside the Home Screen has no Web Push (no PushManager), as on a real device.
  if (ua === IPHONE) await ctx.addInitScript(() => { delete window.PushManager; });
  await ctx.route('**/api/v1/push/config*', (r) => r.fulfill({ json: { enabled: true, status: 'ready', public_key: KEY, this_device: false, this_device_inactive: false, devices: 0 } }));
  const page = await ctx.newPage(); page.setDefaultTimeout(12000);
  const app = page.locator('main#scr');
  await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await pickWho(app, 'yousef@halqa.app'); await app.locator('#lg-email').fill('yousef@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText('السلام عليكم، يوسف').waitFor();
  return { ctx, page, app, sheet: page.getByTestId('reminder-sheet') };
}
const relogHome = async (x) => { await x.page.reload(); await x.app.getByText('السلام عليكم، يوسف').waitFor(); await x.page.waitForTimeout(3500); };

let x = await open();
await step(x.page, 'after sign-in, home shows the sheet; nothing is asked until «تفعيل الإشعارات»', async () => {
  await x.sheet.getByRole('heading', { name: 'فعّل تذكيرات القرآن الكريم' }).waitFor();
  await x.sheet.getByText('هنفكّرك بورد القراءة والمراجعة والحفظ في الأوقات اللي تختارها، حتى لو التطبيق مقفول.').waitFor();
  await x.sheet.getByRole('button', { name: 'تفعيل الإشعارات' }).waitFor(); await x.sheet.getByRole('button', { name: 'ليس الآن' }).waitFor();
  if (await x.page.evaluate(() => window.__asked)) throw new Error('permission asked without a tap');
  await x.page.screenshot({ path: out + '/reminder-sheet.png' });
});
await step(x.page, 'not shown on other screens', async () => {
  await x.page.getByRole('navigation').getByRole('button', { exact: true, name: 'تعلمي' }).click();
  await x.page.waitForTimeout(500);
  if (await x.sheet.count()) throw new Error('sheet on «تعلمي»');
  await x.page.getByRole('navigation').getByRole('button', { exact: true, name: 'الرئيسية' }).click();
});
await step(x.page, 'refused in the browser: device-settings steps once, then never again', async () => {
  await x.sheet.getByRole('button', { name: 'تفعيل الإشعارات' }).click();
  await x.sheet.getByText('رُفض إذن الإشعارات لهذا الموقع، فلن نسألك مرة أخرى.', { exact: false }).waitFor();
  if ((await x.page.evaluate(() => window.__asked)) !== 1) throw new Error('permission not requested exactly once');
  await x.sheet.getByRole('button', { name: 'حسنًا' }).click();
  await relogHome(x);
  if (await x.sheet.count()) throw new Error('asked again after a refusal');
});
await x.ctx.close();

x = await open();
await step(x.page, '«ليس الآن» hides it for 7 days', async () => {
  await x.sheet.getByRole('button', { name: 'ليس الآن' }).click();
  await relogHome(x);
  if (await x.sheet.count()) throw new Error('shown again right after «ليس الآن»');
  const t = Number(await x.page.evaluate(() => localStorage.getItem('halqa.reminderPrompt.later')));
  if (!(Date.now() - t < 60_000)) throw new Error('later time not stored');
});
await x.ctx.close();

x = await open({ permission: 'denied' });
await step(x.page, 'already refused earlier: never shown', async () => {
  await x.page.waitForTimeout(3500);
  if (await x.sheet.count()) throw new Error('shown although notifications were refused');
});
await x.ctx.close();

x = await open({ ua: IPHONE });
await step(x.page, 'iPhone not installed to the Home Screen: install steps first, no enable button', async () => {
  await x.sheet.getByText('على iPhone وiPad تصل الإشعارات إلى التطبيق المثبّت فقط', { exact: false }).waitFor();
  await x.sheet.getByRole('list', { name: 'خطوات التثبيت' }).waitFor();
  if (await x.sheet.getByRole('button', { name: 'تفعيل الإشعارات' }).count()) throw new Error('enable button on iPhone browser');
  if (await x.page.getByTestId('install-sheet').count()) throw new Error('two bottom sheets at once');
});
await x.ctx.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
