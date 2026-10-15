// Live admin courses, lessons, enrollments and quizzes (pack prompt 07), against a seeded dev server:
//   node e2e/admin-content.mjs <shots-dir> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await b.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo' }); page.setDefaultTimeout(10000);
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${out}/content-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const nav = (name) => page.getByRole('navigation', { name: 'أقسام الإدارة' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
const dialog = () => page.getByRole('dialog').last();
const api = async (method, path, token, data) => { const r = await page.request.fetch(BASE + 'api/v1/' + path, { method, data, headers: { Authorization: `Bearer ${token}` } }); return { status: r.status(), body: await r.json().catch(() => null) }; };
const tokenFor = async (email) => (await (await page.request.post(BASE + 'api/v1/auth/login', { data: { email, password: 'halqa123', client: 'native' } })).json()).token;
const n = Date.now() % 100000; const CT = `دورة المدود ${n}`; const LT = `المد الطبيعي ${n}`; const QT = `اختبار المدود ${n}`;

await page.goto(BASE + '#/admin');
await page.locator('#ad-email').fill('admin@halqa.app'); await page.locator('#ad-pw').fill('halqa123');
await page.getByRole('button', { name: 'دخول' }).click(); await page.getByText(/بيانات حقيقية/).waitFor();

await step('create a restricted course with a text lesson', async () => {
  await nav('المحاضرات'); await page.getByRole('button', { name: 'دورة جديدة' }).click();
  await dialog().locator('#co-t').fill(CT); await dialog().locator('#co-tc').selectOption({ label: 'الشيخ عبدالرحمن السالم' });
  await dialog().locator('#co-tp').selectOption('tajweed'); await dialog().getByRole('checkbox').check();
  await dialog().getByRole('button', { name: 'حفظ' }).click(); await dialog().getByText('لا توجد دروس بعد.').waitFor();
  await dialog().getByRole('button', { name: 'إضافة درس' }).click();
  await dialog().getByRole('button', { name: 'حفظ الدرس' }).click(); await dialog().getByText('اكتب عنوان الدرس.').waitFor();
  await dialog().locator('#ls-t').fill(LT); await dialog().locator('#ls-b').fill('المد الطبيعي مقداره حركتان.');
  await dialog().getByRole('button', { name: 'حفظ الدرس' }).click(); await dialog().getByText(LT).waitFor();
});
await step('publishing the course needs a published lesson', async () => {
  await dialog().getByRole('button', { name: 'نشر', exact: true }).click();
  await page.getByText('انشر درسًا واحدًا على الأقل قبل نشر الدورة.').waitFor();
  await dialog().getByRole('button', { name: `نشر ${LT}` }).click(); await dialog().getByRole('button', { name: `إلغاء نشر ${LT}` }).waitFor();
  await dialog().getByRole('button', { name: 'نشر', exact: true }).click(); await dialog().getByRole('button', { name: 'إلغاء النشر', exact: true }).waitFor();
});
let yousef = ''; let sara = ''; let lessonId = 0;
await step('only enrolled students can open the lesson', async () => {
  yousef = await tokenFor('yousef@halqa.app'); sara = await tokenFor('sara@halqa.app');
  if ((await api('GET', 'lessons', yousef)).body.some((l) => l.title === LT)) throw new Error('visible before enrollment');
  await dialog().getByRole('button', { name: 'تسجيل طالب' }).click(); await dialog().getByRole('button', { name: /يوسف أحمد/ }).click();
  await page.reload(); await nav('المحاضرات'); await page.getByRole('button', { name: CT }).click(); await dialog().getByText('يوسف أحمد').waitFor();
  const l = (await api('GET', 'lessons', yousef)).body.find((x) => x.title === LT); if (!l) throw new Error('enrolled student cannot see it');
  lessonId = l.id;
  if ((await api('GET', `lessons/${lessonId}`, sara)).status !== 404) throw new Error('other student can open it');
});
await step('ending the enrollment removes access, keeps the record', async () => {
  await dialog().getByRole('button', { name: 'إنهاء تسجيل يوسف أحمد' }).click(); await dialog().getByRole('button', { name: 'إنهاء التسجيل' }).click();
  await page.reload(); await nav('المحاضرات'); await page.getByRole('button', { name: CT }).click(); await dialog().getByText('منسحب').waitFor();
  if ((await api('GET', `lessons/${lessonId}`, yousef)).status !== 404) throw new Error('still accessible');
});
let qid = 0; let testId = 0;
await step('create a quiz; question validation (Quran range checked)', async () => {
  await page.keyboard.press('Escape'); await nav('الاختبارات'); await page.getByRole('button', { name: 'اختبار جديد' }).click();
  await dialog().locator('#qz-t').fill(QT); await dialog().locator('#qz-a').fill('2'); await dialog().getByRole('button', { name: 'حفظ' }).click();
  await dialog().getByText('لا توجد أسئلة بعد.').waitFor();
  await dialog().getByRole('button', { name: 'إضافة سؤال' }).click();
  await dialog().getByRole('radio', { name: 'تلاوة' }).click(); await dialog().locator('#qq-p').fill('اقرأ أول سورة الفاتحة');
  await dialog().getByLabel('رقم السورة').fill('1'); await dialog().getByLabel('من آية').fill('1'); await dialog().getByLabel('إلى آية').fill('9');
  await dialog().getByRole('button', { name: 'حفظ السؤال' }).click(); await dialog().getByText(/فيها 7 آية/).waitFor();
  await dialog().getByLabel('إلى آية').fill('7'); await dialog().getByRole('button', { name: 'حفظ السؤال' }).click();
  await dialog().getByText(/سورة 1: 1–7/).waitFor();
  await dialog().getByRole('button', { name: 'إضافة سؤال' }).click();
  await dialog().locator('#qq-p').fill('كم حركة للمد الطبيعي؟');
  await dialog().getByLabel('الخيار 1', { exact: true }).fill('حركتان'); await dialog().getByLabel('الخيار 2', { exact: true }).fill('أربع حركات');
  await dialog().getByRole('button', { name: 'حفظ السؤال' }).click(); await dialog().getByText('الصحيح: حركتان').waitFor();
  await dialog().getByRole('button', { name: 'نشر', exact: true }).click(); await dialog().getByRole('button', { name: 'إغلاق الاختبار' }).waitFor();
});
let attempt = 0;
await step('student starts; admin edits a question mid-attempt; the attempt keeps its version', async () => {
  const t = (await api('GET', 'tests', yousef)).body.find((x) => x.title === QT); testId = t.id;
  attempt = (await api('POST', `tests/${testId}/attempts`, yousef)).body.id;
  const qs = (await api('GET', `tests/${testId}`, yousef)).body.questions; qid = qs.find((q) => q.kind === 'mcq').id;
  await dialog().getByRole('button', { name: 'تعديل السؤال 2' }).click();
  await dialog().locator('#qq-p').fill('ما مقدار المد الطبيعي؟'); await dialog().getByRole('button', { name: 'حفظ السؤال' }).click();
  await dialog().getByText('ما مقدار المد الطبيعي؟').waitFor();
  const r = await api('POST', `attempts/${attempt}/submit`, yousef, { answers: [{ question: qid, response: 0 }] });
  if (r.status !== 200 || r.body.objective_score !== 1) throw new Error(`submit ${r.status} ${JSON.stringify(r.body)}`);
  await page.reload(); await nav('الاختبارات'); await page.getByRole('button', { name: QT }).click();
  await dialog().getByText(/نسخة 2/).waitFor(); await dialog().getByText(/1 محاولة مسلّمة/).waitFor();
});
await step('close the quiz: students no longer see it', async () => {
  await dialog().getByRole('button', { name: 'إغلاق الاختبار' }).click(); await dialog().getByText('مغلق').waitFor();
  if ((await api('GET', 'tests', yousef)).body.some((x) => x.id === testId)) throw new Error('closed quiz still listed');
});
await page.screenshot({ path: out + '/content-quiz.png' });
if (errs.length) { fails++; console.log('page errors:', errs); }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
