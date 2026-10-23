// Admin navigation (owner request 23 Oct): grouped vertical sidebar on the right with the HALQA logo, collapsible to
// icons; under 900px a top header whose ☰ opens a right-side drawer. Routes, back/forward, list URLs and logout keep
// working; no page-level horizontal scrolling. node e2e/admin-nav.mjs <shots-dir> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const errs = []; let fails = 0;
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0].replace(/\u001b\[[0-9;]*m/g, '').slice(0, 300)); await p.screenshot({ path: `${out}/nav-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const NAVL = 'التنقل في لوحة الإدارة';
async function signIn(p) {
  await p.goto(BASE + '#/admin');
  await p.locator('#ad-email').fill('admin@halqa.app'); await p.locator('#ad-pw').fill('halqa123');
  await p.getByRole('button', { name: 'دخول' }).click(); await p.getByText(/بيانات حقيقية/).waitFor();
}
const noHorizontalScroll = async (p) => {
  const [sw, cw] = await p.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  if (sw > cw + 1) throw new Error(`page scrolls horizontally: ${sw} > ${cw}`);
};

// ---- desktop ----
const d = await (await b.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo' })).newPage();
d.setDefaultTimeout(10000); d.on('pageerror', (e) => errs.push(e.message));
await signIn(d);
const aside = d.getByRole('complementary', { name: 'القائمة الجانبية' });
const nav = d.getByRole('navigation', { name: NAVL });
const h1 = () => d.getByRole('heading', { level: 1 });

await step(d, 'the HALQA logo and brand sit at the top of a right-hand sidebar', async () => {
  const brand = aside.getByRole('button', { name: /الحلقة — نظرة عامة/ });
  await brand.getByText('HALQA', { exact: true }).waitFor(); await brand.getByText('لوحة الإدارة').waitFor();
  if ((await brand.locator('img').getAttribute('src')) !== '/assets/halqa-mark-ivory.png') throw new Error('logo');
  const box = await aside.boundingBox(); const brandBox = await brand.boundingBox(); const navBox = await nav.boundingBox();
  if (box.x + box.width < 1270 || box.width < 240 || box.width > 280) throw new Error(`sidebar box ${JSON.stringify(box)}`);
  if (!(brandBox.y < navBox.y)) throw new Error('logo is not above the menu');
});
await step(d, 'the menu is vertical, grouped, in the requested order', async () => {
  const items = nav.getByRole('button');
  const names = (await items.allInnerTexts()).map((t) => t.replace(/\d+/g, '').trim());
  const want = ['نظرة عامة', 'الطلاب', 'المعلمون', 'أولياء الأمور', 'الحلقات', 'المحاضرات', 'الاختبارات', 'الجلسات والحجوزات', 'طلبات الاعتذار', 'التقارير', 'الإدارة والصلاحيات', 'الإعدادات'];
  if (JSON.stringify(names) !== JSON.stringify(want)) throw new Error(names.join(' | '));
  const boxes = await Promise.all((await items.all()).map((x) => x.boundingBox()));
  for (let i = 1; i < boxes.length; i++) if (Math.abs(boxes[i].x - boxes[0].x) > 1 || boxes[i].y <= boxes[i - 1].y) throw new Error('not one item per row');
  for (const g of ['المستخدمون', 'التعليم', 'التشغيل', 'الإدارة']) await nav.getByRole('group', { name: g }).waitFor();
});
await step(d, 'the active section is marked, and the logo returns to the overview', async () => {
  await nav.getByRole('button', { name: /^الطلاب/ }).click();
  await h1().filter({ hasText: 'الطلاب' }).waitFor();
  if ((await nav.getByRole('button', { name: /^الطلاب/ }).getAttribute('aria-current')) !== 'page') throw new Error('aria-current');
  if (await nav.locator('[aria-current="page"]').count() !== 1) throw new Error('more than one current item');
  await aside.getByRole('button', { name: /الحلقة — نظرة عامة/ }).click();
  await h1().filter({ hasText: 'نظرة عامة' }).waitFor();
  if (!d.url().endsWith('#/admin/overview')) throw new Error(d.url());
});
await step(d, 'badges appear only for counts above zero', async () => {
  const badges = await nav.locator('[aria-label$="بانتظار إجراء"]').allInnerTexts();
  if (badges.some((t) => t.trim() === '0' || !/^\d+$/.test(t.trim()))) throw new Error(badges.join(','));
});
await step(d, 'collapse to icons; the collapsed menu still navigates; expand again', async () => {
  await aside.getByRole('button', { name: 'طي القائمة' }).click();
  await d.waitForTimeout(400); // width transition
  const box = await aside.boundingBox();
  if (box.width > 88) throw new Error('collapsed width ' + box.width);
  if (await nav.getByText('المعلمون', { exact: true }).count()) throw new Error('labels still shown');
  const t = nav.getByRole('button', { name: /^المعلمون/ });
  if (!(await t.getAttribute('title'))?.startsWith('المعلمون')) throw new Error('no tooltip');
  await t.click(); await h1().filter({ hasText: 'المعلمون' }).waitFor();
  await d.reload(); await d.getByText(/بيانات حقيقية/).waitFor();
  if ((await aside.getAttribute('data-collapsed')) !== '1') throw new Error('collapsed state not remembered');
  await aside.getByRole('button', { name: `حساب المسؤول: مدير المنصة` }).click();
  await d.getByRole('menu').getByRole('button', { name: 'الأمان' }).waitFor();
  await d.keyboard.press('Escape').catch(() => {});
  await aside.getByRole('button', { name: 'توسيع القائمة' }).click(); await d.waitForTimeout(400);
  if ((await aside.boundingBox()).width < 240) throw new Error('not expanded');
});
await step(d, 'browser back/forward and list URLs (search) keep working', async () => {
  await nav.getByRole('button', { name: /^الطلاب/ }).click(); await h1().filter({ hasText: 'الطلاب' }).waitFor();
  await nav.getByRole('button', { name: /^الحلقات/ }).click(); await h1().filter({ hasText: 'الحلقات' }).waitFor();
  await d.goBack(); await h1().filter({ hasText: 'الطلاب' }).waitFor();
  await d.goForward(); await h1().filter({ hasText: 'الحلقات' }).waitFor();
  await nav.getByRole('button', { name: /^الطلاب/ }).click(); await h1().filter({ hasText: 'الطلاب' }).waitFor();
  await d.getByRole('searchbox').first().fill('يوسف');
  await d.waitForFunction(() => decodeURIComponent(location.hash).includes('q=يوسف'));
  await d.reload(); await d.getByText(/بيانات حقيقية/).waitFor();
  if ((await d.getByRole('searchbox').first().inputValue()) !== 'يوسف') throw new Error('search not restored from the URL');
  if ((await nav.getByRole('button', { name: /^الطلاب/ }).getAttribute('aria-current')) !== 'page') throw new Error('active lost');
});
await step(d, 'account block: name, level, «حسابي» / «الأمان» / logout; no horizontal scroll', async () => {
  await aside.getByText('المالك', { exact: true }).waitFor();
  await aside.getByRole('button', { name: 'الأمان' }).click();
  await d.getByRole('dialog', { name: 'الأمان' }).getByText('الأجهزة الموثوقة').waitFor();
  await d.getByRole('dialog', { name: 'الأمان' }).getByRole('button', { name: 'إغلاق' }).click();
  await aside.getByRole('button', { name: 'تسجيل الخروج' }).waitFor();
  await noHorizontalScroll(d);
});
await d.screenshot({ path: out + '/admin-nav-desktop.png' });

// ---- phone ----
const m = await (await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo', isMobile: true, hasTouch: true })).newPage();
m.setDefaultTimeout(10000); m.on('pageerror', (e) => errs.push(e.message));
await signIn(m);
const drawer = m.getByRole('dialog', { name: 'قائمة لوحة الإدارة' });
await step(m, 'phone: a top header with the logo, the page title and ☰; no sidebar', async () => {
  await m.getByRole('button', { name: 'فتح القائمة' }).waitFor();
  if (await m.getByRole('complementary', { name: 'القائمة الجانبية' }).count()) throw new Error('sidebar shown on a phone');
  if (await m.getByRole('navigation', { name: NAVL }).count()) throw new Error('menu shown before ☰');
  await noHorizontalScroll(m);
});
await step(m, 'phone: ☰ opens the drawer from the right; choosing a section closes it', async () => {
  await m.getByRole('button', { name: 'فتح القائمة' }).click();
  const box = await drawer.boundingBox();
  if (Math.abs(box.x + box.width - 390) > 1 || box.width > 390 * 0.9) throw new Error('drawer ' + JSON.stringify(box));
  if ((await drawer.getByRole('navigation', { name: NAVL }).getByRole('button', { name: /^نظرة عامة/ }).getAttribute('aria-current')) !== 'page') throw new Error('current not highlighted');
  await drawer.getByRole('button', { name: /^المعلمون/ }).click();
  await drawer.waitFor({ state: 'detached' });
  await m.getByRole('banner').getByText('المعلمون', { exact: true }).waitFor();
});
await step(m, 'phone: Escape and the backdrop close the drawer; logout is inside it', async () => {
  await m.getByRole('button', { name: 'فتح القائمة' }).click(); await m.keyboard.press('Escape'); await drawer.waitFor({ state: 'detached' });
  await m.getByRole('button', { name: 'فتح القائمة' }).click();
  await m.mouse.click(15, 400); await drawer.waitFor({ state: 'detached' });
  await m.getByRole('button', { name: 'فتح القائمة' }).click();
  await drawer.getByRole('button', { name: 'تسجيل الخروج' }).click();
  await m.locator('#ad-email').waitFor();
});
await m.screenshot({ path: out + '/admin-nav-phone.png' });
if (errs.length) { fails++; console.log('page errors:', errs); }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
