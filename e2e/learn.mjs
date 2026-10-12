// Live lessons, quiz (server grading + teacher grading of the recitation) and progress.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { execSync } from 'node:child_process';
// Re-runnable: SETUP_CMD may reset the student's lesson completions and quiz attempts first.
if (process.env.SETUP_CMD) execSync(process.env.SETUP_CMD, { stdio: 'ignore' });
const out = process.argv[2]; const BASE = process.argv[3] || 'http://localhost:5174/';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
let fails = 0; const errs = [];
async function session(email) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo', permissions: ['microphone'] });
  const page = await ctx.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errs.push(e.message));
  const app = page.locator('main#scr');
  await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.locator('#lg-email').fill(email); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  return { page, app };
}
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${out}/fail-${name.replace(/\W+/g, '_')}.png` }); } };
const S = await session('sara@halqa.app');
await S.app.getByText('السلام عليكم، سارة').waitFor();
const nav = (p, n) => p.getByRole('navigation').getByRole('button', { exact: true, name: n }).click();
await step(S.page, 'lesson library from API, no sample banner', async () => {
  await nav(S.page, 'الجلسات'); await S.app.getByRole('tab', { name: 'الدروس' }).click();
  await S.app.getByText('آداب حامل القرآن').waitFor(); await S.app.getByText('المدود وأنواعها').waitFor();
  if (await S.page.getByText('محتوى تجريبي —').count()) throw new Error('sample banner shown');
});
await step(S.page, 'open lesson, next lesson, mark complete (persists)', async () => {
  await S.app.getByText('مقدمة في أحكام النون الساكنة والتنوين').click();
  await S.app.getByText('من دورة: أساسيات التجويد').waitFor();
  await S.app.getByText('التالي في الدورة').waitFor();
  await S.app.getByRole('button', { name: /علّم الدرس كمكتمل/ }).click();
  await S.app.getByRole('button', { name: /أكملت هذا الدرس/ }).waitFor();
  await S.page.reload(); await S.app.getByText('السلام عليكم، سارة').waitFor();
  await nav(S.page, 'الجلسات'); await S.app.getByRole('tab', { name: 'الدروس' }).click();
  await S.app.locator('button', { hasText: 'مقدمة في أحكام النون الساكنة والتنوين' }).getByText('مكتمل').waitFor();
});
await S.page.screenshot({ path: out + '/q1-lessons.png' });
await step(S.page, 'take quiz: answers + real recitation, server-graded', async () => {
  await S.app.getByRole('tab', { name: 'الاختبارات' }).click();
  await S.app.getByText('اختبار أحكام النون الساكنة والتنوين').click();
  await S.app.getByText('السؤال 1 من 5').waitFor();
  const pick = async (label) => { await S.app.getByRole('radio', { name: label, exact: true }).click(); await S.app.getByRole('button', { exact: true, name: 'التالي' }).click(); };
  await pick('6'); await pick('الإدغام'); await pick('15'); await pick('ينمو');   // 2 right, 2 wrong
  await S.app.getByRole('button', { name: /سجّل إجابتك/ }).click();
  await S.page.waitForTimeout(3000);
  await S.app.getByRole('button', { name: /إنهاء التسجيل/ }).click();
  await S.app.getByText(/سُجّلت إجابتك/).waitFor();
  await S.app.getByRole('button', { exact: true, name: 'تسليم الاختبار' }).click();
  await S.page.getByRole('button', { exact: true, name: 'سلّم الاختبار' }).click();
  await S.app.getByText('2 من 4').waitFor({ timeout: 20000 });
  await S.app.getByText('سؤال التلاوة بانتظار تقييم المعلم').waitFor();
  await S.app.getByText('الإجابة الصحيحة: الإقلاب').waitFor();
});
await S.page.screenshot({ path: out + '/q2-result.png', fullPage: true });
const T = await session('teacher@halqa.app');
await step(T.page, 'teacher grades the quiz recitation', async () => {
  await nav(T.page, 'المراجعات');
  await T.app.getByText(/أسئلة تلاوة في الاختبارات/).waitFor();
  await T.app.getByText('سارة أحمد · اختبار أحكام النون الساكنة والتنوين').waitFor();
  const [r] = await Promise.all([T.page.waitForResponse((x) => x.url().includes('/content?t=')), T.app.locator('audio').first().evaluate((a) => a.play().catch(() => {}))]);
  if (r.status() !== 200) throw new Error('audio ' + r.status());
  await T.app.getByRole('radio', { name: '2', exact: true }).click();
  await T.app.getByRole('button', { name: /حفظ الدرجة/ }).click();
  await T.page.getByText('حُفظت الدرجة').waitFor();
});
await step(S.page, 'student sees final score; progress from real records', async () => {
  await S.page.reload(); await S.app.getByText('السلام عليكم، سارة').waitFor();
  await nav(S.page, 'الجلسات'); await S.app.getByRole('tab', { name: 'الاختبارات' }).click();
  await S.app.getByText('مكتمل · 4 من 6').waitFor();
  await nav(S.page, 'تقدمي');
  await S.app.getByText('دقائق التلاوة التي سجّلتها وسلّمتها').waitFor();
  if (await S.page.getByText('محتوى تجريبي —').count()) throw new Error('sample banner on progress');
});
await S.page.screenshot({ path: out + '/q3-progress.png', fullPage: true });
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no page errors');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); await b.close();
