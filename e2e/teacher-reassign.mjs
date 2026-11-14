// Teacher reassignment (owner report, 14 Nov 2026). An admin moves يوسف from عبدالرحمن (Teacher A) to خالد (Teacher B)
// while all four people have the app open. Checks:
//   - the student's home and «حسابي» show the new teacher WITHOUT a manual reload: once when the app returns to the
//     foreground, once by the background poll alone;
//   - Teacher B's list gains the student and Teacher A's list loses them;
//   - each of the three gets their notice;
//   - after a restart the server still says Teacher B;
//   - the database holds exactly one active assignment.
//   node e2e/teacher-reassign.mjs <shots> [base]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { execSync } from 'node:child_process';
import { pickWho } from './lib/who.mjs';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0].slice(0, 300)); await p.screenshot({ path: `${out}/reassign-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const sql = (q) => execSync(`psql "${process.env.DATABASE_URL}" -At -c "${q}"`).toString().trim();

async function phoneUser(email, ready) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
  const page = await ctx.newPage(); page.setDefaultTimeout(15000);
  const app = page.locator('main#scr');
  await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await pickWho(app, email); await app.locator('#lg-email').fill(email); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText(ready).first().waitFor();
  const nav = (n) => page.getByRole('navigation').getByRole('button', { exact: true, name: n }).click();
  // The app came back to the foreground (switching back from another app on the phone).
  const foreground = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  return { page, app, nav, foreground };
}
const S = await phoneUser('yousef@halqa.app', 'السلام عليكم، يوسف');
const TA = await phoneUser('teacher@halqa.app', /^مرحبًا،/);
const TB = await phoneUser('khalid@halqa.app', /^مرحبًا،/);
const students = (T) => T.app.getByText('يوسف أحمد');

await step(S.page, 'before: the student sees Teacher A; A lists the student, B does not', async () => {
  await S.app.getByTestId('my-teacher').getByText('الأستاذ عبدالرحمن السالم').waitFor();
  await TA.nav('الطلاب'); await students(TA).first().waitFor();
  await TB.nav('الطلاب'); await TB.page.waitForTimeout(800);
  if (await students(TB).count()) throw new Error('Teacher B already lists the student');
});

const actx = await b.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo' });
const A = await actx.newPage(); A.setDefaultTimeout(15000);
const dialog = () => A.getByRole('dialog').last();
await step(A, 'admin: «تغيير المعلم» on the student record', async () => {
  await A.goto(BASE + '#/admin');
  await A.locator('#ad-email').fill('admin@halqa.app'); await A.locator('#ad-pw').fill('halqa123');
  await A.getByRole('button', { name: 'دخول' }).click(); await A.getByText(/بيانات حقيقية/).waitFor();
  await A.getByRole('navigation', { name: 'التنقل في لوحة الإدارة' }).getByRole('button', { name: /^الطلاب/ }).click();
  await A.getByRole('button', { name: 'يوسف أحمد', exact: true }).click(); await dialog().getByText('حالة الحساب').waitFor();
  await dialog().getByRole('button', { name: 'تغيير المعلم' }).click();
  await dialog().getByRole('button', { name: /خالد العمري/ }).click();
  await A.getByText('تم تغيير المعلم وأُبلغ الطالب والمعلمان').waitFor();
  await dialog().getByText('خالد العمري', { exact: false }).first().waitFor();
  if (await dialog().getByText('عبدالرحمن السالم', { exact: false }).count()) throw new Error('admin record still lists Teacher A');
});

await step(S.page, 'database: exactly one active assignment (Teacher B); Teacher A ended and kept', async () => {
  const rows = sql("select u.email, ta.active, ta.end_reason from accounts_teacherassignment ta join accounts_user u on u.id = ta.teacher_id join accounts_user s on s.id = ta.student_id where s.email = 'yousef@halqa.app' order by ta.id");
  const active = rows.split('\n').filter((r) => r.split('|')[1] === 't');
  if (active.length !== 1 || !active[0].startsWith('khalid@halqa.app')) throw new Error(rows);
  if (!rows.includes('teacher@halqa.app|f|reassigned')) throw new Error(rows);
});

await step(S.page, 'student: the home shows Teacher B as soon as the app is in the foreground (no reload)', async () => {
  await S.foreground();
  await S.app.getByTestId('my-teacher').getByText('الأستاذ خالد العمري').waitFor();
  await S.nav('حسابي'); await S.app.getByText('الأستاذ خالد العمري').first().waitFor();
  await S.page.screenshot({ path: out + '/reassign-student.png' });
});
await step(TB.page, 'Teacher B: the student appears (no reload); Teacher A: the student disappears', async () => {
  await TB.foreground(); await students(TB).first().waitFor();
  await TA.foreground(); await students(TA).first().waitFor({ state: 'detached' });
});
await step(S.page, 'notifications: the student, Teacher B and Teacher A each get theirs', async () => {
  const inbox = async (U, title, body) => {
    await U.page.goto(BASE + '#/inbox'); await U.app.getByText(title).first().waitFor();
    if (body) await U.app.getByText(body, { exact: false }).first().waitFor();
  };
  await inbox(S, 'تم تغيير معلمك في حلقة', 'تم تعيين الأستاذ خالد العمري معلمًا لك. يمكنك الآن متابعة الحفظ والمراجعة معه.');
  await inbox(TB, 'طالب جديد في حلقتك', 'تم تعيين الطالب يوسف أحمد ضمن طلابك.');
  await inbox(TA, 'تحديث قائمة الطلاب', 'تم نقل الطالب يوسف أحمد إلى معلم آخر.');
  const n = sql("select count(*) from notifications_notification where kind in ('teacher_assigned','student_assigned','student_moved')");
  if (n !== '3') throw new Error(`expected 3 notification rows, got ${n}`);
  if (sql("select count(*) from notifications_notification where body like '%الشيخ%' and kind in ('teacher_assigned','student_assigned','student_moved')") !== '0') throw new Error('«الأستاذ» used');
});
await step(S.page, 'restart: after closing and reopening the app the server still says Teacher B', async () => {
  await S.page.goto(BASE); await S.page.reload();
  await S.app.getByTestId('my-teacher').getByText('الأستاذ خالد العمري').waitFor();
});
await step(S.page, 'the background poll alone also picks up a change (no foreground event)', async () => {
  // Back to Teacher A (same service as the admin API), then wait for the app's own polling (every 60 s).
  execSync('bash e2e/ci/py.sh reassign_back.py', { stdio: 'inherit' });
  if (sql("select u.email from accounts_teacherassignment ta join accounts_user u on u.id = ta.teacher_id join accounts_user s on s.id = ta.student_id where s.email = 'yousef@halqa.app' and ta.active") !== 'teacher@halqa.app') throw new Error('not moved back');
  await S.app.getByTestId('my-teacher').getByText('الأستاذ عبدالرحمن السالم').waitFor({ timeout: 75000 });
});
await b.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
