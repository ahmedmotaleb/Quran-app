// Support tickets (PROMPT 49): a student opens a ticket with a screenshot from حسابي → الدعم; an admin answers, adds
// an internal note and resolves it; the student sees the team's reply (never the note), gets a notification, and
// closes the ticket. Another student cannot open it. node e2e/support.mjs <shots-dir> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0; const errs = [];
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0].slice(0, 300)); await p.screenshot({ path: `${out}/support-fail-${name.replace(/\W+/g, '_')}.png`, fullPage: true }); } };
async function session(email, viewport = { width: 390, height: 844 }) {
  const page = await (await b.newContext({ viewport, timezoneId: 'Africa/Cairo' })).newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errs.push(e.message));
  return page;
}
const call = (p, method, path) => p.evaluate(async ([m, u]) => (await fetch(u, { method: m, credentials: 'include' })).status, [method, '/api/v1/' + path]);
// A real 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const subject = `لا يظهر الواجب ${Date.now() % 100000}`;

const s = await session(); const app = s.locator('main#scr');
await s.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
await app.locator('#lg-email').fill('sara@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click(); await app.getByText('السلام عليكم، سارة').waitFor();
let ticketId = 0;

await step(s, 'student opens a ticket with a screenshot from حسابي → الدعم', async () => {
  await s.getByRole('button', { name: 'حسابي' }).last().click();
  await app.getByRole('button', { name: 'الدعم والمساعدة' }).click();
  await app.getByRole('button', { name: 'طلب دعم جديد' }).click();
  const f = app.getByRole('form', { name: 'طلب دعم جديد' });
  await f.getByRole('button', { name: 'إرسال' }).click();
  await f.getByText('اختر نوع الطلب.').waitFor();  // validation before sending
  await f.getByLabel('نوع الطلب').selectOption('technical');
  await f.getByLabel('العنوان').fill(subject);
  await f.getByLabel('التفاصيل').fill('أفتح صفحة تعلمي فلا يظهر واجب اليوم.');
  await f.getByLabel('إرفاق لقطة شاشة').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: PNG });
  await f.getByText('shot.png').waitFor();
  const r = s.waitForResponse((x) => x.url().endsWith('/api/v1/support/tickets') && x.request().method() === 'POST');
  await f.getByRole('button', { name: 'إرسال' }).click();
  ticketId = (await (await r).json()).id;
  await app.getByText('الحالة: مفتوح').waitFor();
  await app.getByRole('img', { name: 'صورة مرفقة' }).waitFor();
});
await s.screenshot({ path: out + '/support-student-new.png', fullPage: true });

await step(s, 'a non-image file is refused before sending', async () => {
  await app.getByLabel('إرفاق لقطة شاشة').setInputFiles({ name: 'rec.webm', mimeType: 'audio/webm', buffer: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]) });
  await app.getByText('أرفق صورة فقط (PNG أو JPEG أو WebP).').waitFor();
});

const a = await session(null, { width: 1280, height: 900 });
await a.goto(BASE + '#/admin');
await a.locator('#ad-email').fill('admin@halqa.app'); await a.locator('#ad-pw').fill('halqa123');
await a.getByRole('button', { name: 'دخول' }).click(); await a.getByText(/بيانات حقيقية/).waitFor();
const dlg = () => a.getByRole('dialog', { name: `طلب دعم #${ticketId}` });

await step(a, 'admin sees it under «طلبات الدعم» with a badge and opens it', async () => {
  const nav = a.getByRole('navigation', { name: 'التنقل في لوحة الإدارة' });
  await nav.getByRole('button', { name: /طلبات الدعم/ }).click();
  await a.getByRole('heading', { level: 1, name: 'طلبات الدعم' }).waitFor();
  await a.getByRole('button', { name: subject }).click();
  await dlg().getByText('أفتح صفحة تعلمي').waitFor();
  await dlg().getByRole('img', { name: 'صورة مرفقة' }).waitFor();
});

await step(a, 'internal note, then a public reply that resolves the ticket', async () => {
  const form = dlg().getByRole('form', { name: 'الرد على طلب الدعم' });
  await form.getByRole('radio', { name: 'ملاحظة داخلية' }).click();
  await form.getByRole('textbox').fill('ملاحظة سرية للفريق: الواجب مؤرشف.');
  await form.getByRole('button', { name: 'حفظ الملاحظة' }).click();
  await dlg().getByText(/^ملاحظة داخلية · /).waitFor();
  await form.getByRole('radio', { name: 'رد على صاحب الطلب' }).click();
  await form.getByRole('textbox').fill('أعدنا الواجب إلى قائمتك، حدّث الصفحة من فضلك.');
  await form.getByLabel('الحالة بعد الرد').selectOption('resolved');
  await form.getByRole('button', { name: 'إرسال الرد' }).click();
  await dlg().getByRole('list', { name: 'المحادثة' }).getByText('أعدنا الواجب إلى قائمتك').waitFor();
  for (let i = 0; i < 20 && (await dlg().locator('select').first().inputValue()) !== 'resolved'; i++) await a.waitForTimeout(250);
  const st = await dlg().locator('select').first().inputValue();
  if (st !== 'resolved') throw new Error(`status ${st}`);
});
await a.screenshot({ path: out + '/support-admin.png', fullPage: true });

await step(s, 'student sees «فريق الدعم» reply, not the internal note, and gets a notification', async () => {
  await s.reload(); await app.getByText('السلام عليكم، سارة').waitFor();
  await app.getByRole('button', { name: /الإشعارات، \d+ غير مقروءة/ }).click();
  await app.getByText('تم حل طلب الدعم').click();
  await app.getByText('أعدنا الواجب إلى قائمتك').waitFor();
  await app.getByText(/^فريق الدعم · /).waitFor();
  await app.getByText('الحالة: تم الحل').waitFor();
  if (await app.getByText('ملاحظة سرية').count()) throw new Error('internal note visible to the student');
});

await step(s, 'student closes the ticket; replying is no longer offered', async () => {
  await app.getByRole('button', { name: 'تم حل مشكلتي، أغلق الطلب' }).click();
  await s.getByRole('button', { name: 'إغلاق الطلب' }).last().click();
  await app.getByText('هذا الطلب مغلق.').waitFor();
});

const y = await session(); const yapp = y.locator('main#scr');
await y.goto(BASE); await yapp.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
await yapp.locator('#lg-email').fill('yousef@halqa.app'); await yapp.locator('#lg-pw').fill('halqa123');
await yapp.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click(); await yapp.getByText(/السلام عليكم/).waitFor();
await step(y, "another student gets 404 for Sara's ticket and sees no tickets", async () => {
  const st = await call(y, 'GET', `support/tickets/${ticketId}`);
  if (st !== 404) throw new Error(`status ${st}`);
  const list = await y.evaluate(async () => (await (await fetch('/api/v1/support/tickets', { credentials: 'include' })).json()).results.length);
  if (list !== 0) throw new Error(`${list} tickets visible`);
});

console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no page errors');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails || errs.length ? 1 : 0; await b.close();
