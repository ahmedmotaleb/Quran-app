// «القراءات والروايات»: a new teacher ticks Riwayat (at least one; nothing preselected) → the admin sees them, edits and
// confirms, approves the teacher → students see the Riwayat on the card and the teacher's page and filter by one.
// An existing teacher with none keeps working and is asked to add them. Mobile 390 px / 320 px, RTL.
//   QIRAAT_CMD="bash e2e/ci/py.sh qiraat_teacher.py" node e2e/qiraat.mjs <shots> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { pickWho } from './lib/who.mjs';
import { execSync } from 'node:child_process';
if (process.env.QIRAAT_CMD) execSync(process.env.QIRAAT_CMD, { stdio: 'inherit' });
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0].slice(0, 300)); await p.screenshot({ path: `${out}/qiraat-fail-${name.replace(/\W+/g, '_')}.png` }); } };
async function learner(email, hello, width = 390) {
  const ctx = await b.newContext({ viewport: { width, height: 844 }, timezoneId: 'Africa/Cairo' });
  const page = await ctx.newPage(); page.setDefaultTimeout(10000);
  const app = page.locator('main#scr');
  await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await pickWho(app, email); await app.locator('#lg-email').fill(email); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText(hello).first().waitFor();
  return { ctx, page, app };
}

const T = await learner('qtest@halqa.app', 'مرحبًا، الأستاذ أحمد محمد', 320);
await step(T.page, 'new teacher: section shown on home, nothing preselected, at least one required', async () => {
  const sec = T.app.getByRole('region', { name: 'القراءات والروايات' });
  await sec.getByText('اختر الروايات التي تجيدها ومؤهل لتدريسها').waitFor();
  await sec.getByRole('button', { name: 'أضف القراءات والروايات' }).click();
  const asim = sec.getByRole('group', { name: 'عاصم الكوفي' });
  const first = asim.getByRole('checkbox').first();
  if ((await asim.locator('label').first().innerText()).trim() !== 'حفص عن عاصم') throw new Error('حفص is not first');
  if (await sec.getByRole('checkbox', { checked: true }).count()) throw new Error('something is preselected');
  await sec.getByRole('button', { name: 'حفظ وإرسال للإدارة' }).click();
  await sec.getByText('اختر رواية واحدة على الأقل.').waitFor();
  await first.check();
  await sec.getByRole('button', { name: 'نافع المدني' }).click();                     // collapsed group opens
  await sec.getByRole('group', { name: 'نافع المدني' }).getByRole('checkbox', { name: 'ورش عن نافع' }).check();
  for (const c of await sec.getByRole('checkbox').all()) {                              // large touch targets
    const bb = await c.locator('xpath=..').boundingBox(); if (bb.height < 44) throw new Error('small checkbox row ' + bb.height);
  }
  if (await T.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('horizontal scroll at 320 px');
  await T.page.screenshot({ path: out + '/qiraat-teacher-pick.png' });
  await sec.getByRole('button', { name: 'حفظ وإرسال للإدارة' }).click();
  await T.page.getByText('حُفظت القراءات والروايات وأُرسلت للإدارة للاعتماد').waitFor();
  await sec.getByText('ورش عن نافع · بانتظار الاعتماد').waitFor(); await sec.getByText('حفص عن عاصم · بانتظار الاعتماد').waitFor();
});

const S = await learner('yousef@halqa.app', 'السلام عليكم، يوسف');
const teachersTab = async () => {
  await S.page.reload(); await S.app.getByText('السلام عليكم، يوسف').waitFor();
  await S.page.getByRole('navigation').getByRole('button', { exact: true, name: 'الجلسات' }).click();
  await S.app.getByRole('tab', { name: 'المعلمون' }).click();
};
await step(S.page, 'an unapproved teacher is not offered to students; existing teachers without Riwayat still are', async () => {
  await teachersTab();
  await S.app.getByRole('button', { name: /الأستاذ عبدالرحمن السالم/ }).waitFor();
  if (await S.app.getByRole('button', { name: /أحمد محمد/ }).count()) throw new Error('unapproved teacher listed');
});

const actx = await b.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo' });
const A = await actx.newPage(); A.setDefaultTimeout(10000);
await step(A, 'admin sees the selection, edits, confirms and approves (audited)', async () => {
  await A.goto(BASE + '#/admin');
  await A.locator('#ad-email').fill('admin@halqa.app'); await A.locator('#ad-pw').fill('halqa123');
  await A.getByRole('button', { name: 'دخول' }).click(); await A.getByText(/بيانات حقيقية/).waitFor();
  await A.getByRole('navigation', { name: 'التنقل في لوحة الإدارة' }).getByRole('button', { name: /^المعلمون/ }).click();
  await A.getByRole('button', { name: /أحمد محمد/ }).first().click();
  const d = A.getByRole('dialog').last(); await d.getByText('حالة الحساب').waitFor();
  await d.getByText('الاعتماد يؤكد الروايات التي اختارها المعلم', { exact: false }).waitFor();
  await d.getByText('حفص عن عاصم · بانتظار الاعتماد').waitFor();
  await d.getByRole('button', { exact: true, name: 'تعديل' }).click();
  await d.getByRole('group', { name: 'عاصم الكوفي' }).getByRole('checkbox', { name: 'شعبة عن عاصم' }).check();
  await d.getByRole('button', { name: 'حفظ وتأكيد' }).click();
  await A.getByText('حُفظت القراءات والروايات وأُكّدت').waitFor();
  await d.getByText('شعبة عن عاصم', { exact: true }).waitFor();                         // confirmed chips (no «· بانتظار الاعتماد»)
  if (await d.getByText('· بانتظار الاعتماد', { exact: false }).count()) throw new Error('still pending after confirm');
  await d.getByRole('button', { name: 'اعتماد المعلم' }).click(); await A.getByText(/تم اعتماد المعلم/).waitFor();
  await A.screenshot({ path: out + '/qiraat-admin.png' });
});

await step(S.page, 'students see the confirmed Riwayat and filter teachers by one', async () => {
  await teachersTab();
  const card = S.app.getByRole('button', { name: /أحمد محمد/ });
  await card.getByText('الروايات: ورش عن نافع · شعبة عن عاصم · حفص عن عاصم').waitFor();
  const f = S.app.getByLabel('الرواية');
  await f.selectOption('warsh');
  await card.waitFor(); if (await S.app.getByRole('button', { name: /الأستاذ عبدالرحمن السالم/ }).count()) throw new Error('filter kept a teacher without ورش');
  await f.selectOption('qalun'); await S.app.getByText('لا توجد نتائج مطابقة').waitFor();
  await f.selectOption('all'); await S.app.getByRole('button', { name: /الأستاذ عبدالرحمن السالم/ }).waitFor();
  await card.click();
  const sec = S.app.getByRole('region', { name: 'القراءات والروايات' });
  await sec.getByText('حفص عن عاصم').waitFor(); await sec.getByText('ورش عن نافع').waitFor();
  await S.page.screenshot({ path: out + '/qiraat-student.png' });
});

const E = await learner('teacher@halqa.app', 'مرحبًا، الأستاذ عبدالرحمن السالم');
await step(E.page, 'existing teacher with none: asked to add them, nothing assumed', async () => {
  const sec = E.app.getByRole('region', { name: 'القراءات والروايات' });
  await sec.getByRole('button', { name: 'أضف القراءات والروايات' }).waitFor();
  if (await sec.getByText('حفص عن عاصم').count()) throw new Error('Hafs assumed');
});
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
