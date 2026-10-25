// Excuses and the absence rule (owner decision 23 October 2026), end to end in the app:
//  A. The student has no «إلغاء الحجز»; «طلب اعتذار» → «الاعتذار قيد المراجعة»; the teacher sees it under
//     «طلبات الاعتذار» and accepts; the student sees «تم قبول الاعتذار» and «غاب بعذر»; nothing counts.
//  B. Two earlier unexcused absences (setup) + the teacher marks the third session «غائب» → the account is suspended:
//     the student cannot sign in, the admin sees the reason and 3 absences, the parent is told.
//   ABS_CMD="bash e2e/ci/py.sh absences.py" node e2e/excuses.mjs <shots> [base-url]
import { execSync } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0; const errs = [];
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${out}/excuses-fail-${name.replace(/\W+/g, '_')}.png` }); } };
async function session(email) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
  const page = await ctx.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => errs.push(email + ': ' + e.message));
  const app = page.locator('main#scr');
  await page.goto(BASE);
  const skip = app.getByRole('button', { exact: true, name: 'تخطَّ' }); await skip.or(app.locator('#lg-email')).first().waitFor();
  if (await skip.count()) await skip.click();
  await app.locator('#lg-email').fill(email); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  return { page, app, ctx };
}
const native = async (p, email) => (await (await p.request.post(BASE + 'api/v1/auth/login', { data: { email, password: 'halqa123', client: 'native' } })).json());
const apiGet = async (p, token, path) => (await p.request.get(BASE + 'api/v1/' + path, { headers: { Authorization: `Bearer ${token}` } })).json();

// ---- A. accepted excuse ---------------------------------------------------------------------
const S = await session('yousef@halqa.app');
await S.app.getByText('السلام عليكم، يوسف').waitFor();
let bookingId = null;
await step(S.page, 'student books a session (server)', async () => {
  const me = await native(S.page, 'yousef@halqa.app');
  const H = { Authorization: `Bearer ${me.token}` };
  const teachers = (await (await S.page.request.get(BASE + 'api/v1/teachers', { headers: H })).json()).results;
  const t = teachers.find((x) => x.display_name === 'الشيخ عبدالرحمن السالم');
  const slots = await (await S.page.request.get(BASE + `api/v1/teachers/${t.id}/slots`, { headers: H })).json();
  const slot = (slots.results ?? slots).find((x) => new Date(x.starts_at).getTime() > Date.now() + 26 * 3600_000 && x.seats_left > 0);
  const r = await S.page.request.post(BASE + 'api/v1/bookings', { headers: { ...H, 'Idempotency-Key': 'e2e-excuse-' + Date.now() }, data: { occurrence: slot.id } });
  bookingId = (await r.json()).id; if (!bookingId) throw new Error('booking ' + r.status());
  await S.page.reload(); await S.app.getByText('السلام عليكم، يوسف').waitFor();
});
await step(S.page, 'no «إلغاء الحجز»; «طلب اعتذار» → «الاعتذار قيد المراجعة»', async () => {
  await S.page.getByRole('button', { exact: true, name: 'الجلسات' }).click();
  await S.app.getByRole('tab', { name: 'حجوزاتي' }).click();
  await S.app.getByText('الشيخ عبدالرحمن السالم · فردية').first().click();
  if (await S.app.getByRole('button', { exact: true, name: 'إلغاء الحجز' }).count()) throw new Error('cancel button shown to the student');
  await S.app.getByRole('button', { exact: true, name: 'طلب اعتذار' }).click();
  const d = S.page.getByRole('dialog', { name: 'طلب اعتذار عن الجلسة' });
  await d.locator('#ex-r').fill('ظرف');
  await d.getByRole('button', { name: 'إرسال الاعتذار' }).click();
  await d.getByText('اكتب سبب الاعتذار (5 أحرف على الأقل).').waitFor();
  await d.locator('#ex-r').fill('ظرف عائلي طارئ');
  await d.getByRole('button', { name: 'إرسال الاعتذار' }).click();
  await S.app.getByText('الاعتذار قيد المراجعة').waitFor();
});
const T = await session('teacher@halqa.app');
await step(T.page, 'teacher sees «طلبات الاعتذار» and accepts', async () => {
  await T.app.getByText('مرحبًا، الشيخ عبدالرحمن السالم').waitFor();
  await T.page.getByRole('navigation').getByRole('button', { exact: true, name: 'المواعيد' }).click();
  const panel = T.app.getByRole('region', { name: 'طلبات الاعتذار' });
  await panel.getByText('يوسف أحمد').waitFor(); await panel.getByText('السبب: ظرف عائلي طارئ').waitFor();
  await panel.getByRole('button', { name: 'رفض العذر' }).click();
  await panel.getByRole('button', { name: 'تأكيد الرفض' }).click();
  await panel.getByText('اكتب سبب رفض الاعتذار.').waitFor();       // rejecting needs a reason
  await panel.getByRole('button', { name: 'رجوع' }).click();
  await panel.getByRole('button', { name: 'قبول العذر' }).click();
  await T.page.getByText('قُبل العذر وأُبلغ الطالب').waitFor();
  await T.app.getByText('اعتذار مقبول').first().waitFor();
});
await step(S.page, 'student sees «تم قبول الاعتذار» and «غاب بعذر»; nothing counts', async () => {
  await S.page.reload(); await S.app.getByText('السلام عليكم، يوسف').waitFor();
  await S.page.getByRole('button', { exact: true, name: 'الجلسات' }).click();
  await S.app.getByRole('tab', { name: 'حجوزاتي' }).click();
  await S.app.getByText('الشيخ عبدالرحمن السالم · فردية').first().click();
  await S.app.getByText('تم قبول الاعتذار').waitFor();
  await S.app.getByText('غاب بعذر').waitFor();
});
await S.page.screenshot({ path: out + '/excuse-accepted.png' });

// ---- C. the admin decides pending requests in «طلبات الاعتذار» ---------------------------------------------
await step(S.page, 'admin accepts one excuse and rejects another; rows disappear and the badge updates', async () => {
  const me = await native(S.page, 'yousef@halqa.app'); const H = { Authorization: `Bearer ${me.token}` };
  const t = (await (await S.page.request.get(BASE + 'api/v1/teachers', { headers: H })).json()).results.find((x) => x.display_name === 'الشيخ عبدالرحمن السالم');
  const slots = await (await S.page.request.get(BASE + `api/v1/teachers/${t.id}/slots`, { headers: H })).json();
  // Start times are computed every 15 minutes, so neighbours overlap: take times at least two hours apart.
  const free = [];
  for (const x of (slots.results ?? slots)) {
    const t = new Date(x.starts_at).getTime();
    if (t > Date.now() + 26 * 3600_000 && x.seats_left > 0 && free.every((f) => Math.abs(new Date(f.starts_at).getTime() - t) >= 2 * 3600_000)) free.push(x);
  }
  for (const [i, reason] of [['a', 'سفر مع الأسرة'], ['b', 'موعد طبي مهم']].entries()) {
    const r = await S.page.request.post(BASE + 'api/v1/bookings', { headers: { ...H, 'Idempotency-Key': `e2e-adm-ex-${reason[0]}-${Date.now()}` }, data: { occurrence: free[i + 1].id } });
    const id = (await r.json()).id; if (!id) throw new Error('booking ' + r.status());
    const e = await S.page.request.post(BASE + `api/v1/bookings/${id}/excuse`, { headers: H, data: { reason: reason[1] } });
    if (e.status() !== 201) throw new Error('excuse ' + e.status());
  }
  const A = await b.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo' }); const ap = await A.newPage(); ap.setDefaultTimeout(12000);
  ap.on('pageerror', (e) => errs.push('admin: ' + e.message));
  await ap.goto(BASE + '#/admin');
  await ap.locator('#ad-email').fill('admin@halqa.app'); await ap.locator('#ad-pw').fill('halqa123');
  await ap.getByRole('button', { name: 'دخول' }).click(); await ap.getByText(/بيانات حقيقية/).waitFor();
  try { await adminDecides(ap); } catch (e) { await ap.screenshot({ path: out + '/excuses-fail-admin-portal.png' }); throw e; }
  await A.close();
  const inbox = JSON.stringify(await apiGet(S.page, me.token, 'notifications'));
  if (!inbox.includes('رد الإدارة: يرجى الالتزام بالموعد')) throw new Error('student not told of the rejection');
});
async function adminDecides(ap) {
  const nav = ap.getByRole('navigation', { name: 'التنقل في لوحة الإدارة' });
  await nav.getByRole('button', { name: /^طلبات الاعتذار\s*2 بانتظار إجراء$/ }).click();
  const row = (txt) => ap.locator('[data-excuse]').filter({ hasText: txt });
  await row('سفر مع الأسرة').getByRole('button', { name: 'قبول العذر' }).click();
  let d = ap.getByRole('dialog', { name: 'قبول اعتذار الطالب؟' });
  await d.getByText('سبب الاعتذار: سفر مع الأسرة').waitFor();
  await d.getByRole('button', { name: 'تأكيد القبول' }).click();
  await ap.getByRole('status').filter({ hasText: 'تم قبول الاعتذار' }).waitFor();
  await row('سفر مع الأسرة').waitFor({ state: 'detached' });
  await nav.getByRole('button', { name: /^طلبات الاعتذار\s*1 بانتظار إجراء$/ }).waitFor();
  await row('موعد طبي مهم').getByRole('button', { name: 'رفض العذر' }).click();
  d = ap.getByRole('dialog', { name: 'رفض اعتذار الطالب' });
  await d.getByRole('button', { name: 'تأكيد الرفض' }).click();
  await d.getByText('اكتب سبب رفض الاعتذار (3 أحرف على الأقل).').waitFor();
  await d.locator('#ex-resp').fill('يرجى الالتزام بالموعد');
  await d.getByRole('button', { name: 'تأكيد الرفض' }).click();
  await ap.getByRole('status').filter({ hasText: 'تم رفض الاعتذار' }).waitFor();
  await ap.getByText('لا توجد طلبات اعتذار معلقة.').waitFor();
  await nav.getByRole('button', { name: 'طلبات الاعتذار', exact: true }).waitFor();   // no badge left
  await ap.getByRole('tab', { name: 'مرفوضة' }).click();
  await row('موعد طبي مهم').getByText('بقرار الإدارة').waitFor();
  await row('موعد طبي مهم').getByText('الرد: يرجى الالتزام بالموعد').waitFor();
  if (await row('موعد طبي مهم').getByRole('button').count()) throw new Error('buttons on a decided row');
  await ap.getByRole('tab', { name: 'مقبولة' }).click();
  await row('سفر مع الأسرة').getByText('بقرار الإدارة').waitFor();
  await ap.screenshot({ path: out + '/excuse-admin-decided.png' });
}

// ---- B. third unexcused absence ---------------------------------------------------------------
if (process.env.ABS_CMD) execSync(process.env.ABS_CMD, { stdio: 'inherit' });
await step(T.page, 'teacher marks the third session «غائب» → the student is suspended', async () => {
  await T.page.reload(); await T.app.getByText('مرحبًا، الشيخ عبدالرحمن السالم').waitFor();
  await T.page.getByRole('navigation').getByRole('button', { exact: true, name: 'المواعيد' }).click();
  const group = T.app.getByRole('radiogroup', { name: 'حضور سارة أحمد' });
  const unmarked = group.filter({ hasNot: T.page.locator('[aria-checked=true]') }).first();
  const resp = T.page.waitForResponse((r) => r.url().includes('/attendance') && r.request().method() === 'POST');
  await unmarked.getByRole('radio', { name: 'غائب', exact: true }).click();
  if ((await resp).status() !== 200) throw new Error('attendance ' + (await resp).status());
  const r = await native(T.page, 'sara@halqa.app');
  if (r.code !== 'account_suspended') throw new Error('sara can still sign in: ' + JSON.stringify(r).slice(0, 120));
});
await step(T.page, 'admin sees «3 — الحساب موقوف» and the reason; the parent was told', async () => {
  const A = await b.newContext({ viewport: { width: 1280, height: 900 } }); const ap = await A.newPage(); ap.setDefaultTimeout(12000);
  await ap.goto(BASE + '#/admin');
  await ap.locator('#ad-email').fill('admin@halqa.app'); await ap.locator('#ad-pw').fill('halqa123');
  await ap.getByRole('button', { name: 'دخول' }).click(); await ap.getByText(/بيانات حقيقية/).waitFor();
  await ap.getByRole('navigation', { name: 'التنقل في لوحة الإدارة' }).getByRole('button', { name: /^الطلاب/ }).click();
  await ap.getByRole('group', { name: 'تصفية حسب الحالة' }).getByRole('button', { name: /موقوف/ }).click();
  await ap.getByRole('button', { name: 'سارة أحمد', exact: true }).click();
  await ap.getByText('الغياب بدون عذر: 3 — الحساب موقوف').waitFor();
  await ap.getByText('سبب الحالة: تجاوز الحد المسموح للغياب بدون عذر (3 غيابات)', { exact: false }).waitFor();
  await ap.screenshot({ path: out + '/excuse-suspended-admin.png' });
  await A.close();
  const p = await native(T.page, 'parent@halqa.app');
  const inbox = await apiGet(T.page, p.token, 'notifications');
  if (!JSON.stringify(inbox).includes('تم إيقاف حساب سارة')) throw new Error('parent not told');
});
if (errs.length) { fails++; console.log('FAIL page errors', errs[0]); } else console.log('no page errors');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
