// The real-device failure (22 October 2026), end to end in the app with a fake microphone:
//  1. «سجّل تلاوتك» from Home opens the recorder on a real open task (it used to send the demo id → assignments/NaN).
//  2. A failed upload (HTML 502 from a proxy) shows a specific message with the request id and every action; the
//     recording is kept on the device («حفظ وإرسال لاحقًا»).
//  3. After closing/reopening the app, Home shows «لديك تسجيل لم يتم إرساله»; «إكمال الإرسال» restores it and sends it.
//  4. The teacher plays it; nothing of it remains in the device storage.
//  5. Another account on the same phone never sees a pending recording; deleting asks for confirmation.
//   node e2e/recording-flow.mjs <shots> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo', permissions: ['microphone'] });
const page = await ctx.newPage(); page.setDefaultTimeout(15000);
const app = page.locator('main#scr');
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const nan = []; page.on('request', (r) => { if (/\/NaN\b|\/k1\b/.test(r.url())) nan.push(r.url()); });
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${out}/recflow-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const signIn = async (email) => {
  await page.goto(BASE);
  const skip = app.getByRole('button', { exact: true, name: 'تخطَّ' }); const emailBox = app.locator('#lg-email');
  await skip.or(emailBox).first().waitFor();
  if (await skip.count()) await skip.click();
  await app.locator('#lg-email').fill(email); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
};
const pendingCount = () => page.evaluate(async () => {
  const P = await import('/src/services/pendingRec.ts');
  return (await P.listPending('*')).length + (await new Promise((res) => { const r = indexedDB.open('halqa-recordings'); r.onsuccess = () => {
    const tx = r.result.transaction('pending', 'readonly'); const q = tx.objectStore('pending').count(); q.onsuccess = () => res(q.result); }; r.onerror = () => res(0); }));
});
const record = async (secs = 4) => {
  await app.getByRole('button', { name: 'ابدأ التسجيل' }).click();
  await page.waitForTimeout(secs * 1000 + 300);
  await app.getByRole('button', { name: /إنهاء التسجيل/ }).click();
  await app.getByText('استمع قبل التسليم').waitFor();
};

await signIn('yousef@halqa.app');
await app.getByText('السلام عليكم، يوسف').waitFor();
await step('Home «سجّل تلاوتك» opens the recorder on a real open task', async () => {
  await app.getByRole('button', { name: 'سجّل تلاوتك' }).last().click();
  await app.getByRole('radio', { checked: true }).waitFor();
});
await step('record, then an HTML 502 on upload: specific message, request id, all actions', async () => {
  await record(4);
  await page.route('**/api/v1/media/recitations', (r) => r.fulfill({ status: 502, contentType: 'text/html', headers: { 'X-Request-ID': 'proxy-req-77' }, body: '<html>502</html>' }));
  await app.getByRole('button', { name: /تسليم التلاوة/ }).click();
  await app.getByText('تعذّر رفع التسجيل. حاول مرة أخرى').waitFor();
  await app.getByText(/رقم الخطأ: proxy-req-77/).waitFor();
  await app.getByText(/محفوظ على هذا الجهاز/).waitFor();
  for (const n of ['إعادة المحاولة', 'حفظ وإرسال لاحقًا', 'حذف التسجيل']) await app.getByRole('button', { name: n }).waitFor();
  await app.getByLabel('الاستماع للتسجيل').waitFor();
  await page.unroute('**/api/v1/media/recitations');
});
await page.screenshot({ path: out + '/recflow-failed.png' });
await step('«حفظ وإرسال لاحقًا» keeps it; Home shows the unsent recording', async () => {
  await app.getByRole('button', { name: 'حفظ وإرسال لاحقًا' }).click();
  await page.getByText('التسجيل محفوظ على هذا الجهاز').first().waitFor();
  const home = page.getByRole('button', { exact: true, name: 'الرئيسية' }); if (await home.count()) await home.click();
  await app.getByText('لديك تسجيل لم يتم إرساله').waitFor();
});
await step('closing and reopening the app keeps it; «إكمال الإرسال» restores and sends it', async () => {
  await page.reload();
  await app.getByText('لديك تسجيل لم يتم إرساله').waitFor();
  await app.getByRole('button', { name: 'إكمال الإرسال' }).click();
  await app.getByText(/لديك تسجيل لم يتم إرساله/).first().waitFor();
  const btn = app.getByRole('button', { name: /إكمال الإرسال|تسليم التلاوة/ }).first();
  await btn.click();
  await app.getByText('تم تسليم تلاوتك').waitFor({ timeout: 30000 });
  if (await pendingCount()) throw new Error('the sent recording is still stored on the device');
});
await page.screenshot({ path: out + '/recflow-sent.png' });
await step('the teacher can play the submitted recording', async () => {
  const t = await (await page.request.post(BASE + 'api/v1/auth/login', { data: { email: 'teacher@halqa.app', password: 'halqa123', client: 'native' } })).json();
  const H = { Authorization: `Bearer ${t.token}` };
  const subs = (await (await page.request.get(BASE + 'api/v1/submissions', { headers: H })).json()).results;
  const s = subs.find((x) => x.student_name === 'يوسف أحمد' && x.audio?.url);
  if (!s) throw new Error('no submission with audio for the teacher');
  const url = s.audio.url.startsWith('http') ? s.audio.url : BASE + s.audio.url.replace(/^\//, '');
  const a = await page.request.get(url);
  if (a.status() !== 200 || !(a.headers()['content-type'] || '').startsWith('audio/') || (await a.body()).length < 500) throw new Error('audio ' + a.status());
});
await step('another account on the same phone never sees a pending recording', async () => {
  await app.getByRole('button', { name: 'الرئيسية' }).first().click();
  await app.getByText('السلام عليكم، يوسف').waitFor();
  await app.getByRole('button', { name: 'سجّل تلاوتك' }).last().click();
  await app.getByRole('radio', { checked: true }).waitFor();
  await record(3);
  await page.route('**/api/v1/media/recitations', (r) => r.abort('internetdisconnected'));
  await app.getByRole('button', { name: /تسليم التلاوة/ }).click();
  await app.getByText('تعذّر الاتصال بالخادم. التسجيل محفوظ ويمكن إعادة المحاولة.').waitFor();
  await page.unroute('**/api/v1/media/recitations');
  await app.getByRole('button', { name: 'حفظ وإرسال لاحقًا' }).click();
  await page.evaluate(async () => { const L = await import('/src/store/live.ts'); await L.logout(); });
  await page.goto(BASE); await signIn('sara@halqa.app');
  await app.getByText('السلام عليكم، سارة').waitFor();
  await page.waitForTimeout(800);
  if (await app.getByText('لديك تسجيل لم يتم إرساله').count()) throw new Error("sara sees yousef's recording");
});
await step('back as the owner: delete asks first, then removes it from the device', async () => {
  await page.evaluate(async () => { const L = await import('/src/store/live.ts'); await L.logout(); });
  await page.goto(BASE); await signIn('yousef@halqa.app');
  await app.getByText('لديك تسجيل لم يتم إرساله').waitFor();
  await app.getByRole('button', { name: 'حذف التسجيل' }).click();
  await page.getByText('لن يمكن استعادته.').waitFor();
  await page.getByRole('button', { name: 'احذف التسجيل' }).click();
  await app.getByText('لديك تسجيل لم يتم إرساله').waitFor({ state: 'detached' });
  if (await pendingCount()) throw new Error('still stored');
});
await step('no request ever used a demo or NaN task id', async () => { if (nan.length) throw new Error(nan[0]); });
if (errs.length) { fails++; console.log('FAIL page errors', errs[0]); } else console.log('no page errors');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
