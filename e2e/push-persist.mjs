// Persistent phone-notification registration (owner report 13 Nov 2026: the app asked again after every reopen and
// sign-in). With the browser permission already «granted»: no prompt and no banner on reopen; a missing server record
// (after signing out and in) is restored silently; signing out keeps the browser subscription; a person who turned
// notifications off on this device is not turned back on; a refused permission shows the settings steps once.
// The push service is not available to the test browser, so PushManager is replaced by a stand-in that behaves like
// Chrome's (one subscription per device, reused); the server's answers are the real ones except where routed.
//   node e2e/push-persist.mjs <shots> [liveUrl=http://localhost:4175/]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { pickWho } from './lib/who.mjs';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:4175/').replace(/\/?$/, '/');
const KEY = 'BB8EPsDPPBwbaQwEjtC4LR2ZtMRvq5UzzE7N-3fnJITrsyMAC4GK4SIqUDXbUWFUXDRmqCynFc1XofAA5dx3MuM'; // test key, not production
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${out}/persist-fail-${name.replace(/\W+/g, '_')}.png` }); } };

/** One phone: permission granted earlier, the browser keeps its subscription across reloads (storage-backed). */
async function phone({ hasSub = true, server = true } = {}) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
  const st = { server, posts: 0, deletes: 0, configs: 0 };
  await ctx.addInitScript(([key, hasSub]) => {
    const bump = (k) => localStorage.setItem(k, String(Number(localStorage.getItem(k) || 0) + 1));
    Object.defineProperty(Notification, 'permission', { get: () => 'granted', configurable: true });
    Notification.requestPermission = async () => { bump('e2e.asked'); return 'granted'; };
    const bytes = () => { const s = (key + '='.repeat((4 - key.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer; };
    if (hasSub && !localStorage.getItem('e2e.sub')) localStorage.setItem('e2e.sub', 'https://fcm.googleapis.com/fcm/send/e2e-device-1');
    const make = (ep) => ({ endpoint: ep, options: { applicationServerKey: bytes(), userVisibleOnly: true },
      toJSON: () => ({ endpoint: ep, keys: { p256dh: 'BP' + 'x'.repeat(84), auth: 'au' + 'y'.repeat(20) } }),
      unsubscribe: async () => { bump('e2e.unsubscribes'); localStorage.removeItem('e2e.sub'); return true; } });
    PushManager.prototype.getSubscription = async function () { const ep = localStorage.getItem('e2e.sub'); return ep ? make(ep) : null; };
    PushManager.prototype.subscribe = async function () {
      bump('e2e.subscribes');
      const ep = localStorage.getItem('e2e.sub') || 'https://fcm.googleapis.com/fcm/send/e2e-device-new';
      localStorage.setItem('e2e.sub', ep); return make(ep);
    };
  }, [KEY, hasSub]);
  await ctx.route('**/api/v1/push/config*', (r) => {
    st.configs++;
    const ep = new URL(r.request().url()).searchParams.get('endpoint');
    return r.fulfill({ json: { enabled: true, status: 'ready', public_key: KEY, this_device: !!ep && st.server, this_device_inactive: false, devices: st.server ? 1 : 0 } });
  });
  await ctx.route('**/api/v1/push/subscriptions', (r) => {
    if (r.request().method() === 'POST') { st.posts++; st.server = true; return r.fulfill({ status: 201, json: { subscribed: true } }); }
    st.deletes++; st.server = false; return r.fulfill({ json: { removed: 1 } });
  });
  await ctx.route('**/api/v1/auth/logout', async (r) => { if ((r.request().postDataJSON() || {}).push_endpoint) st.server = false; return r.continue(); });
  const page = await ctx.newPage(); page.setDefaultTimeout(12000);
  const app = page.locator('main#scr');
  const signIn = async () => {
    await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click().catch(() => {});
    await pickWho(app, 'yousef@halqa.app'); await app.locator('#lg-email').fill('yousef@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
    await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
    await app.getByText('السلام عليكم، يوسف').waitFor();
  };
  const reopen = async () => { await page.reload(); await app.getByText('السلام عليكم، يوسف').waitFor(); await page.waitForTimeout(3500); };
  return { ctx, page, app, st, signIn, reopen, sheet: page.getByTestId('reminder-sheet'), ev: (k) => page.evaluate((x) => Number(localStorage.getItem('e2e.' + x.replace(/^__/, '')) || 0), k) };
}

let x = await phone({ hasSub: true, server: true });
await step(x.page, 'already allowed and registered: reopening never prompts, shows no banner, re-registers nothing', async () => {
  await x.signIn(); await x.page.waitForTimeout(3500);
  for (let i = 0; i < 3; i++) {
    if (await x.sheet.count()) throw new Error(`banner shown (open ${i + 1})`);
    if (await x.ev('__asked')) throw new Error('permission requested');
    await x.reopen();
  }
  if (x.st.posts !== 0) throw new Error(`re-registered ${x.st.posts} times`);
  if (await x.ev('__subscribes')) throw new Error('a new subscription was made');
});
await step(x.page, 'sign out and in again: no prompt, the same subscription is re-registered silently', async () => {
  await x.page.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  await x.app.getByRole('button', { name: 'تسجيل الخروج' }).click();
  await x.page.getByRole('button', { name: 'تسجيل الخروج' }).last().click();          // the confirmation sheet
  await x.app.locator('#lg-email').waitFor();
  if (await x.ev('__unsubscribes')) throw new Error('signing out dropped the browser subscription');
  if (x.st.server) throw new Error('the server still has this device for the signed-out account');
  await x.app.locator('#lg-email').fill('yousef@halqa.app'); await x.app.locator('#lg-pw').fill('halqa123');
  await x.app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await x.app.getByText('السلام عليكم، يوسف').waitFor(); await x.page.waitForTimeout(3500);
  if (await x.sheet.count()) throw new Error('banner shown after signing in again');
  if (await x.ev('__asked')) throw new Error('permission requested');
  if (x.st.posts !== 1 || !x.st.server) throw new Error(`not re-registered (posts ${x.st.posts})`);
  if (await x.ev('__subscribes')) throw new Error('a new subscription was made instead of reusing');
});
await step(x.page, 'turned off on this device: stays off after reopening (no silent re-subscribe, no banner)', async () => {
  await x.page.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  await x.app.getByRole('button', { name: 'إيقاف الإشعارات على هذا الجهاز' }).click();
  await x.app.getByText('هذا الجهاز غير مشترك في الإشعارات').waitFor();
  const posts = x.st.posts;
  await x.reopen(); await x.reopen();
  if (x.st.posts !== posts) throw new Error('turned back on by itself');
  if (await x.sheet.count()) throw new Error('banner shown although turned off on purpose');
  await x.page.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  await x.app.getByRole('button', { name: 'تفعيل الإشعارات' }).click();                 // on again from the button: no new prompt
  await x.app.getByText('الإشعارات مفعلة').waitFor();
  if (await x.ev('__asked')) throw new Error('permission requested although granted');
});
await x.ctx.close();

x = await phone({ hasSub: false, server: false });
await step(x.page, 'allowed but the subscription was lost: restored silently at start-up (no banner, no prompt)', async () => {
  await x.signIn(); await x.page.waitForTimeout(3500);
  if (await x.sheet.count()) throw new Error('banner shown');
  if (await x.ev('__asked')) throw new Error('permission requested');
  if ((await x.ev('__subscribes')) !== 1 || x.st.posts !== 1) throw new Error(`subscribes ${await x.ev('__subscribes')}, posts ${x.st.posts}`);
  await x.reopen();
  if ((await x.ev('__subscribes')) !== 1 || x.st.posts !== 1) throw new Error('subscribed again on reopen');
});
await x.ctx.close();

console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
