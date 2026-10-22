// Multi-admin (owner request, 23 Oct 2026), against a seeded dev server: node e2e/admin-admins.mjs <shots-dir> [base-url]
// The owner invites an «مدير أكاديمي» by email; the invitee accepts (email-bound link), must turn on two-step
// verification, then sees only the allowed sections; the server refuses the rest; the owner narrows the access and
// suspends the account, which ends the session.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { createHmac } from 'node:crypto';
import { linkFor } from './lib/mailbox.mjs';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const owner = await b.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo' }); owner.setDefaultTimeout(10000);
const ctx2 = await b.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo' });
const page = await ctx2.newPage(); page.setDefaultTimeout(10000);
const errs = []; for (const p of [owner, page]) p.on('pageerror', (e) => errs.push(e.message));
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0].replace(/\u001b\[[0-9;]*m/g, '').slice(0, 300)); await owner.screenshot({ path: `${out}/admins-fail-owner-${name.replace(/\W+/g, '_')}.png` }); await page.screenshot({ path: `${out}/admins-fail-new-${name.replace(/\W+/g, '_')}.png` }); } };
const navOf = (p) => p.getByRole('navigation', { name: 'أقسام الإدارة' });
const dialog = (p) => p.getByRole('dialog').last();
function totp(secret, t = Date.now()) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) bits += alpha.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((x) => parseInt(x, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = createHmac('sha1', key).update(msg).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
/** A request made by the signed-in portal page itself (same session and CSRF token as the UI). */
const call = (p, method, path, body) => p.evaluate(async ([m, url, b]) => {
  const P = { 'X-Halqa-Portal': 'admin' }; // the portal's own session (accounts/authentication.py)
  const t = (await (await fetch('/api/v1/auth/csrf', { credentials: 'include', headers: P })).json()).csrfToken;
  const r = await fetch('/api/v1/' + url, { method: m, credentials: 'include', headers: { ...P, 'Content-Type': 'application/json', 'X-CSRFToken': t }, body: b ? JSON.stringify(b) : undefined });
  return r.status;
}, [method, path, body]);
const EMAIL = `academic${Date.now()}@example.com`; const PW = 'Academic-Pass-2026';

await owner.goto(BASE + '#/admin');
await owner.locator('#ad-email').fill('admin@halqa.app'); await owner.locator('#ad-pw').fill('halqa123');
await owner.getByRole('button', { name: 'دخول' }).click(); await owner.getByText(/بيانات حقيقية/).waitFor();

await step('the owner sees «الإدارة والصلاحيات» and invites an academic manager by email', async () => {
  await navOf(owner).getByRole('button', { name: /^الإدارة والصلاحيات/ }).click();
  await owner.getByText('مدير المنصة (أنت)').waitFor();
  await owner.getByRole('button', { name: 'إضافة مسؤول' }).click();
  await dialog(owner).locator('#ad-n').fill('مدير أكاديمي تجريبي'); await dialog(owner).locator('#ad-e').fill(EMAIL);
  if (await dialog(owner).locator('#ad-p').inputValue() !== 'academic_manager') throw new Error('default preset');
  await dialog(owner).getByRole('button', { name: 'إرسال الدعوة' }).click();
  await owner.getByText(/أُرسلت الدعوة إلى البريد/).waitFor();
  await owner.getByText(EMAIL).waitFor(); // listed under open invitations
});
let link = '';
await step('the email has the admin subject and a one-time admin link', async () => {
  const m = await linkFor(EMAIL);
  if (m.subject !== 'دعوة للانضمام إلى إدارة حَلْقة') throw new Error(`subject ${m.subject}`);
  if (!/kind=admin/.test(m.link)) throw new Error('no kind=admin');
  link = BASE + m.link.slice(m.link.indexOf('#'));
});
await step('a different email cannot use the link', async () => {
  await page.goto(link); await page.getByRole('heading', { name: 'الانضمام إلى إدارة حَلْقة' }).waitFor();
  await page.locator('#iv-name').fill('مدير أكاديمي تجريبي'); await page.locator('#iv-email').fill('someone-else@example.com'); await page.locator('#iv-pw').fill(PW);
  await page.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await page.getByText('اكتب البريد الذي وصلته الدعوة.').waitFor();
});
await step('the invitee creates the account and is sent to the admin portal', async () => {
  await page.locator('#iv-email').fill(EMAIL); await page.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await page.getByRole('link', { name: 'الذهاب إلى لوحة الإدارة' }).waitFor();
});
let secret = '';
await step('two-step verification is mandatory before any section', async () => {
  await page.goto(BASE + '#/admin');
  await page.locator('#ad-email').fill(EMAIL); await page.locator('#ad-pw').fill(PW); await page.getByRole('button', { name: 'دخول' }).click();
  await page.getByText('تُفتح أقسام الإدارة بعد تفعيل التحقق بخطوتين.').waitFor();
  await page.getByRole('button', { name: 'ابدأ التفعيل' }).click();
  secret = (await page.locator('code').innerText()).trim();
  await page.locator('#mfa-otp').fill(totp(secret)); await page.getByRole('button', { name: 'تأكيد التفعيل' }).click();
  await page.getByRole('heading', { name: 'فعّل التحقق بخطوتين' }).waitFor({ state: 'detached' });
});
await step('the academic manager sees only allowed sections', async () => {
  await navOf(page).getByRole('button', { name: /^الطلاب/ }).waitFor();
  await navOf(page).getByRole('button', { name: /^الحلقات/ }).waitFor();
  for (const hidden of ['الإعدادات', 'الإدارة والصلاحيات']) if (await navOf(page).getByRole('button', { name: new RegExp(`^${hidden}`) }).count()) throw new Error(`${hidden} shown`);
  await page.goto(BASE + '#/admin/admins'); await page.waitForTimeout(500);
  if (await page.getByRole('button', { name: 'إضافة مسؤول' }).count()) throw new Error('admins screen opened');
});
await step('the server refuses what the portal hides', async () => {
  const st = (path) => call(page, 'GET', path);
  for (const [p, want] of [['admin/admins', 403], ['admin/settings', 403], ['admin/users?role=student', 200]]) { const got = await st(p); if (got !== want) throw new Error(`${p} ${got}`); }
});
await step('the owner narrows the access to «مشاهدة فقط»; the next request follows it', async () => {
  await owner.reload(); await owner.getByText('مدير أكاديمي تجريبي').waitFor();
  await owner.getByRole('button', { name: 'تعديل صلاحيات مدير أكاديمي تجريبي' }).click();
  await dialog(owner).locator('#ad-p').selectOption('read_only');
  await dialog(owner).getByRole('button', { name: 'حفظ الصلاحيات' }).click();
  await owner.getByText(/حُفظت الصلاحيات/).waitFor();
  await page.reload(); await navOf(page).getByRole('button', { name: /^الطلاب/ }).click();
  await page.getByRole('searchbox').first().waitFor();
  if (await page.getByRole('button', { name: 'إضافة طالب' }).count()) throw new Error('add student still shown');
  const r = await call(page, 'POST', 'admin/users', { full_name: 'طالب', email: `s${Date.now()}@example.com`, role: 'student' });
  if (r !== 403) throw new Error(`create student ${r}`);
});
await step('the owner cannot remove their own access, and suspending the admin ends their session', async () => {
  if (await owner.getByRole('button', { name: 'تعديل صلاحيات مدير المنصة' }).count()) throw new Error('self edit offered');
  await owner.getByRole('button', { name: 'إيقاف مدير أكاديمي تجريبي' }).click();
  await dialog(owner).locator('#rs').fill('انتهاء التكليف'); await dialog(owner).getByRole('button', { name: 'إيقاف', exact: true }).click();
  await owner.getByText('موقوف').waitFor();
  await page.reload(); await page.locator('#ad-email').waitFor();
});
await owner.screenshot({ path: out + '/admins.png', fullPage: true });
if (errs.length) { fails++; console.log('page errors:', errs); }
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
