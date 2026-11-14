// «الأذكار والأدعية»: the admin adds the proposed Quranic verses (text copied from the verified Quran text), approves
// one, rejects one with a reason, and adds a Sunnah entry (refused without collection/number/grading). A student sees
// only the approved entry with its source, opens it, favorites it, changes «إعدادات الأذكار والتنبيهات» (saved by the
// server), and a tapped adhkar reminder (`#/n/<id>`) opens that entry. 390 px, RTL.
//   NOTE_CMD="bash e2e/ci/py.sh adhkar_notice.py" node e2e/adhkar.mjs <shots> [base]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pickWho } from './lib/who.mjs';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0].slice(0, 300)); await p.screenshot({ path: `${out}/adhkar-fail-${name.replace(/\W+/g, '_')}.png` }); } };

const actx = await b.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo' });
const A = await actx.newPage(); A.setDefaultTimeout(15000);
let approvedSource = '';
await step(A, 'admin: «مكتبة الأذكار» adds the proposed verses for review (nothing published yet)', async () => {
  await A.goto(BASE + '#/admin');
  await A.locator('#ad-email').fill('admin@halqa.app'); await A.locator('#ad-pw').fill('halqa123');
  await A.getByRole('button', { name: 'دخول' }).click(); await A.getByText(/بيانات حقيقية/).waitFor();
  await A.getByRole('navigation', { name: 'التنقل في لوحة الإدارة' }).getByRole('button', { name: /^مكتبة الأذكار/ }).click();
  const sec = A.getByTestId('admin-adhkar');
  await sec.getByText('لا توجد أذكار هنا', { exact: false }).waitFor();
  await sec.getByRole('button', { name: 'إضافة المحتوى الموثّق' }).click();
  await A.getByText(/أُضيف \d+ ذكر للمراجعة/).waitFor();
  await sec.locator('[data-dhikr]').first().waitFor();
  if ((await sec.locator('[data-dhikr]').count()) < 20) throw new Error('too few proposed verses');
  await sec.locator('[data-dhikr]').first().getByText('بانتظار المراجعة').waitFor();
  await sec.locator('[data-dhikr]').first().getByText('القرآن الكريم ·', { exact: false }).waitFor();
});
await step(A, 'admin: approve one, reject one (a reason is required)', async () => {
  const sec = A.getByTestId('admin-adhkar');
  const first = sec.locator('[data-dhikr]').first();
  approvedSource = (await first.locator('p', { hasText: 'المصدر:' }).innerText()).replace(/^المصدر:\s*القرآن الكريم ·\s*/, '').trim();
  const firstId = await first.getAttribute('data-dhikr');
  await first.getByRole('button', { name: 'اعتماد' }).click();
  await A.getByText('اعتُمد الذكر').waitFor();
  await sec.locator(`[data-dhikr="${firstId}"]`).waitFor({ state: 'detached' });     // left «بانتظار المراجعة»
  await sec.locator('[data-dhikr]').first().getByRole('button', { name: 'رفض' }).click();
  const d = A.getByRole('dialog').last();
  await d.getByRole('button', { name: 'رفض' }).click();
  await d.getByText('اكتب سبب الرفض', { exact: false }).waitFor();
  await d.getByRole('textbox').fill('مكررة في المكتبة');
  await d.getByRole('button', { name: 'رفض' }).click();
  await A.getByText('رُفض الذكر').waitFor();
  await sec.getByRole('tab', { name: /^معتمدة/ }).click();
  await sec.locator('[data-dhikr]').first().getByText(approvedSource, { exact: false }).waitFor();
  await sec.getByRole('tab', { name: /^مرفوضة/ }).click();
  await sec.locator('[data-dhikr]').first().getByText('سبب: مكررة في المكتبة', { exact: false }).waitFor();
});
await step(A, 'admin: a Sunnah entry needs collection, number and grading; it waits for review', async () => {
  const sec = A.getByTestId('admin-adhkar');
  await sec.getByRole('button', { name: 'إضافة ذكر' }).click();
  const d = A.getByRole('dialog').last();
  await d.getByLabel('المصدر', { exact: true }).selectOption('hadith');
  await d.locator('option[value="sunnah_dua"]').waitFor({ state: 'attached' });   // categories arrive with the list (slow servers)
  await d.getByLabel('الفئة').selectOption('sunnah_dua');
  await d.getByLabel('نص الحديث كما في المصدر').fill('نص اختبار آلي');
  await d.getByRole('button', { name: 'إضافة للمراجعة' }).click();
  await d.getByText('مطلوب لمصدر الحديث.').first().waitFor();
  await d.getByLabel('الكتاب (مثل: صحيح البخاري)').fill('كتاب اختبار');
  await d.getByLabel('رقم الحديث').fill('1');
  await d.getByLabel('الدرجة').selectOption('sahih');
  const created = A.waitForResponse((r) => r.url().endsWith('/api/v1/admin/adhkar') && r.request().method() === 'POST');
  await d.getByRole('button', { name: 'إضافة للمراجعة' }).click();
  if ((await created).status() !== 201) throw new Error(`create ${(await created).status()}`);
  await sec.getByRole('tab', { name: /^بانتظار المراجعة/ }).click();
  await sec.getByLabel('المصدر', { exact: true }).selectOption('hadith');
  await sec.getByRole('searchbox', { name: 'بحث في نص الذكر' }).fill('نص اختبار آلي');
  await sec.locator('[data-dhikr]', { hasText: 'كتاب اختبار (١) · صحيح' }).waitFor({ timeout: 20000 });
  await sec.getByRole('searchbox', { name: 'بحث في نص الذكر' }).fill('');
});
await step(A, 'admin: delivery stats', async () => {
  const sec = A.getByTestId('admin-adhkar');
  await sec.getByRole('tab', { name: 'الإرسال والإحصاءات' }).click();
  await sec.getByTestId('adhkar-stats').getByText('أذكار معتمدة').waitFor();
  await sec.getByRole('region', { name: 'الإرسال الفاشل' }).waitFor();
  await A.screenshot({ path: out + '/adhkar-admin.png' });
});

if (process.env.NOTE_CMD) execSync(process.env.NOTE_CMD, { stdio: 'inherit' });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
const page = await ctx.newPage(); page.setDefaultTimeout(15000);
const app = page.locator('main#scr');
await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
await pickWho(app, 'yousef@halqa.app'); await app.locator('#lg-email').fill('yousef@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
await app.getByText('السلام عليكم، يوسف').waitFor();

await step(page, 'student: the library lists only the approved entry, with its source; opens, favorites', async () => {
  await page.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  await app.getByTestId('open-adhkar').click();
  const lib = app.getByTestId('adhkar-library');
  const items = lib.getByRole('list', { name: 'الأذكار' }).getByRole('listitem');
  await items.first().waitFor();
  if ((await items.count()) !== 1) throw new Error(`expected only the approved entry, got ${await items.count()}`);
  await items.first().getByText(approvedSource, { exact: false }).waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('sideways scroll');
  await page.screenshot({ path: out + '/adhkar-library.png' });
  await items.first().click();
  const v = app.getByTestId('dhikr-view');
  await v.getByText(`القرآن الكريم · ${approvedSource}`).waitFor();
  await v.getByRole('button', { name: '☆ أضف إلى المفضلة' }).click();
  await page.getByText('أُضيف إلى المفضلة').waitFor();
  await page.screenshot({ path: out + '/adhkar-detail.png' });
  await page.goto(BASE); await app.getByText('السلام عليكم، يوسف').waitFor();
  await page.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  await app.getByTestId('open-adhkar').click();
  await lib.getByRole('tab', { name: 'المفضلة' }).click();
  await lib.getByRole('list', { name: 'الأذكار' }).getByRole('listitem').first().getByText('★', { exact: false }).waitFor();
});
await step(page, '«إعدادات الأذكار والتنبيهات»: saved by the server, invalid window refused', async () => {
  await page.goto(BASE); await app.getByText('السلام عليكم، يوسف').waitFor();
  await page.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  const s = app.getByTestId('adhkar-settings');
  await s.getByText('بتوقيت منطقتك الزمنية', { exact: false }).waitFor();
  if ((await s.getByLabel('تكرار التذكيرات').inputValue()) !== '2') throw new Error('default is not every 2 hours');
  await s.getByLabel('تكرار التذكيرات').selectOption('3');
  await page.getByText('حُفظت إعدادات الأذكار').first().waitFor();
  await s.getByLabel('بداية التذكيرات').selectOption('23');
  await s.getByRole('alert').waitFor();
  await page.reload(); await app.getByText('السلام عليكم، يوسف').waitFor();
  await page.getByRole('navigation').getByRole('button', { exact: true, name: 'حسابي' }).click();
  const s2 = app.getByTestId('adhkar-settings');
  await s2.getByLabel('تكرار التذكيرات').waitFor();
  if ((await s2.getByLabel('تكرار التذكيرات').inputValue()) !== '3') throw new Error('interval not saved');
  if ((await s2.getByLabel('بداية التذكيرات').inputValue()) !== '8') throw new Error('invalid window kept');
});
await step(page, 'a tapped adhkar reminder opens that entry with its source (and is not in the learning inbox)', async () => {
  const id = readFileSync('/tmp/adhkar-note-id', 'utf8').trim();
  await page.goto(BASE + '#/n/' + id);
  await app.getByTestId('dhikr-view').getByText(approvedSource, { exact: false }).waitFor();
  await page.goto(BASE); await app.getByText('السلام عليكم، يوسف').waitFor();
  await app.getByRole('button', { name: /الإشعارات/ }).first().click();
  await page.waitForTimeout(800);
  if (await app.getByText('الحلقة | ', { exact: false }).count()) throw new Error('adhkar notice listed in the inbox');
});
await b.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
