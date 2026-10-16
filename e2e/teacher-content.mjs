// Teacher content authoring in live mode (pack prompt 07, teacher side): the teacher writes a lesson (in a new
// draft course) and a quiz; both persist as drafts; the admin overview lists them for review; the admin publishes;
// the student sees the lesson; the teacher sees it published and can no longer delete it.
//   node e2e/teacher-content.mjs <shots-dir> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const errs = [];
let fails = 0;
const stamp = Date.now().toString(36).slice(-4);
const CT = `دورة المخارج ${stamp}`, LT = `مخارج الحلق ${stamp}`, QT = `اختبار المخارج ${stamp}`;
async function learner(email) {
  const page = await (await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' })).newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errs.push(e.message));
  const app = page.locator('main#scr');
  await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.locator('#lg-email').fill(email); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  return { page, app };
}
const call = (p, method, path, body) => p.evaluate(async ([m, u, bd]) => {
  const csrf = (await (await fetch('/api/v1/auth/csrf', { credentials: 'include' })).json()).csrfToken;
  const r = await fetch(u, { method: m, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf }, body: bd ? JSON.stringify(bd) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, '/api/v1/' + path, body]);
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${out}/tcontent-fail-${name.replace(/\W+/g, '_')}.png` }); } };

const T = await learner('teacher@halqa.app');
await T.app.getByText('مرحبًا، الشيخ عبدالرحمن السالم').waitFor();
const open = async () => { await T.page.goto(BASE + '#/'); await T.app.getByRole('button', { name: /محاضرة أو اختبار/ }).click(); await T.app.getByRole('heading', { name: 'إنشاء محتوى' }).waitFor(); };
await step(T.page, 'no sample banner; the review rule is shown', async () => {
  await open();
  await T.app.getByText('يحفظ المعلم المحتوى كمسودة، وتنشره إدارة الحلقة بعد المراجعة.').waitFor();
  if (await T.page.getByText(/بيانات عرض|محتوى تجريبي/).count()) throw new Error('sample label still shown');
});
await step(T.page, 'missing fields are explained, nothing is saved', async () => {
  await T.app.getByRole('button', { name: 'حفظ الدرس كمسودة' }).click();
  await T.app.getByText('أدخل عنوان الدرس').waitFor(); await T.app.getByText('اكتب نص الدرس').waitFor();
});
await step(T.page, 'write a lesson in a new draft course; it persists', async () => {
  await T.app.locator('#tl-course').selectOption('new');
  await T.app.locator('#tl-ctitle').fill(CT); await T.app.locator('#tl-title').fill(LT);
  await T.app.locator('#tl-body').fill('الحلق مخرج للهمزة والهاء والعين والحاء والغين والخاء.'); await T.app.locator('#tl-mins').fill('8');
  await T.app.getByRole('button', { name: 'حفظ الدرس كمسودة' }).click();
  await T.page.getByText('حُفظ الدرس كمسودة بانتظار النشر').waitFor();
  await T.page.reload(); await open();
  await T.app.getByText(LT).waitFor(); await T.app.locator('strong', { hasText: CT }).waitFor();
});
await step(T.page, 'a video link must be YouTube or Vimeo (server rule)', async () => {
  await T.app.locator('#tl-title').fill('رابط خاطئ'); await T.app.getByRole('button', { name: 'رابط فيديو' }).click();
  await T.app.locator('#tl-url').fill('https://example.com/video.mp4');
  await T.app.getByRole('button', { name: 'حفظ الدرس كمسودة' }).click();
  await T.app.getByText(/YouTube أو Vimeo/).first().waitFor();
});
await step(T.page, 'write a quiz (multiple choice + true/false + recitation); it persists', async () => {
  await T.app.getByRole('button', { exact: true, name: 'اختبار' }).click();
  await T.app.locator('#tq-title').fill(QT);
  await T.app.getByRole('button', { name: /اختيار من متعدد/ }).click();
  await T.app.getByLabel('نص السؤال 1').fill('ما مخرج حرف العين؟');
  await T.app.getByLabel('الخيار 1', { exact: true }).fill('وسط الحلق'); await T.app.getByLabel('الخيار 2', { exact: true }).fill('الشفتان');
  await T.app.getByRole('button', { name: /صح أو خطأ/ }).click();
  await T.app.getByLabel('نص السؤال 2').fill('الهمزة من أقصى الحلق');
  await T.app.getByRole('button', { name: /سؤال تلاوة/ }).click();
  await T.app.getByLabel('نص السؤال 3').fill('سجّل أول سورة الملك');
  await T.app.getByLabel('رقم السورة (اختياري)').fill('67'); await T.app.getByLabel('من الآية').fill('1'); await T.app.getByLabel('إلى الآية').fill('4');
  await T.app.getByRole('button', { name: 'حفظ الاختبار كمسودة' }).click();
  await T.page.getByText('حُفظ الاختبار كمسودة بانتظار النشر').waitFor();
  await T.page.reload(); await open();
  await T.app.getByText(QT).waitFor(); await T.app.getByText('3 أسئلة').first().waitFor();
});
await T.page.screenshot({ path: out + '/teacher-content.png' });

// Admin: the overview lists the drafts; publishing makes the lesson visible to students.
const A = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage(); A.setDefaultTimeout(10000);
let lessonId = 0, courseId = 0, quizId = 0;
await step(A, 'admin overview lists teacher drafts for review', async () => {
  await A.goto(BASE + '#/admin');
  await A.locator('#ad-email').fill('admin@halqa.app'); await A.locator('#ad-pw').fill('halqa123');
  await A.getByRole('button', { name: /^(دخول|تحقق ودخول)$/ }).click();
  await A.getByText(/دروس مسودة بانتظار المراجعة والنشر \(\d+ من المعلمين\)/).waitFor();
  await A.getByText(/اختبارات مسودة بانتظار المراجعة والنشر \(\d+ من المعلمين\)/).waitFor();
  const courses = (await call(A, 'GET', `admin/courses?q=${encodeURIComponent(CT)}`)).body.results;
  courseId = courses[0].id;
  lessonId = (await call(A, 'GET', `admin/courses/${courseId}`)).body.lesson_list.find((l) => l.title === LT).id;
  quizId = (await call(A, 'GET', `admin/tests?q=${encodeURIComponent(QT)}`)).body.results[0].id;
});
await step(A, 'admin publishes the lesson, course and quiz', async () => {
  for (const [path, body] of [[`admin/lessons/${lessonId}/state`, { state: 'published' }], [`admin/courses/${courseId}/state`, { state: 'published' }], [`admin/tests/${quizId}/state`, { state: 'published' }]]) {
    const r = await call(A, 'POST', path, body); if (r.status !== 200) throw new Error(`${path} → ${r.status} ${JSON.stringify(r.body)}`);
  }
});
const S = await learner('yousef@halqa.app');
await step(S.page, 'the student sees the published lesson', async () => {
  await S.app.getByText('السلام عليكم، يوسف').waitFor();
  const r = await call(S.page, 'GET', 'lessons');
  if (!r.body.some((l) => l.title === LT)) throw new Error('lesson not in the student library');
});
await step(T.page, 'the teacher sees it published, without a delete button', async () => {
  await T.page.reload(); await open();
  const row = T.app.getByText(LT).locator('..');
  await row.getByText('منشور').waitFor();
  if (await T.app.getByRole('button', { name: `حذف مسودة ${LT}` }).count()) throw new Error('published lesson still deletable');
});
if (errs.length) { fails++; console.log('FAIL page errors:', errs.slice(0, 3).join(' | ')); }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
