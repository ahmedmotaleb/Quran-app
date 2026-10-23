// CSV student import (PROMPT 50): الطلاب → استيراد CSV → preview (valid / duplicate / error) → error file → confirm →
// per-row result; the new student is in the list and got a setup email. node e2e/student-import.mjs <shots> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { readFileSync, readdirSync } from 'node:fs';
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Africa/Cairo', acceptDownloads: true });
const p = await ctx.newPage(); p.setDefaultTimeout(10000);
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0].slice(0, 300)); await p.screenshot({ path: `${out}/import-fail-${name.replace(/\W+/g, '_')}.png`, fullPage: true }); } };
const n = Date.now() % 100000;
const CSV = '﻿full_name,email,phone,timezone,level,teacher_email,circle\r\n'
  + `طالب مستورد ${n},imported${n}@example.com,,Africa/Cairo,مبتدئ,teacher@halqa.app,\r\n`
  + 'يوسف مكرر,yousef@halqa.app,,,,,\r\n'
  + 'س,not-an-email,,Mars/Base,,,\r\n';

await p.goto(BASE + '#/admin');
await p.locator('#ad-email').fill('admin@halqa.app'); await p.locator('#ad-pw').fill('halqa123');
await p.getByRole('button', { name: 'دخول' }).click(); await p.getByText(/بيانات حقيقية/).waitFor();
await p.getByRole('navigation', { name: 'التنقل في لوحة الإدارة' }).getByRole('button', { name: /^الطلاب/ }).click();
const dlg = () => p.getByRole('dialog', { name: 'استيراد طلاب من ملف CSV' });

await step('template downloads with the expected columns', async () => {
  await p.getByRole('button', { name: 'استيراد CSV' }).click();
  const [d] = await Promise.all([p.waitForEvent('download'), dlg().getByRole('button', { name: 'تنزيل القالب' }).click()]);
  const f = `${out}/template.csv`; await d.saveAs(f);
  if (readFileSync(f, 'utf8') !== '﻿full_name,email,phone,timezone,level,teacher_email,circle\r\n') throw new Error(readFileSync(f, 'utf8'));
});

await step('preview shows valid, duplicate and error rows and writes nothing', async () => {
  await dlg().getByLabel('ملف CSV').setInputFiles({ name: 'students.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
  await dlg().getByRole('button', { name: 'معاينة' }).click();
  await dlg().getByText('3 صف: صالح 1 · مكرر 1 · أخطاء 1').waitFor();
  await dlg().getByText('البريد مستخدم لحساب موجود.').waitFor();
  await dlg().getByText(/بريد إلكتروني غير صالح/).waitFor();
});
await p.screenshot({ path: out + '/import-preview.png', fullPage: true });

await step('the error file lists the rows that will not be created', async () => {
  const [d] = await Promise.all([p.waitForEvent('download'), dlg().getByRole('button', { name: /تنزيل ملف الصفوف غير المُنشأة \(2\)/ }).click()]);
  const f = `${out}/import-errors.csv`; await d.saveAs(f); const t = readFileSync(f, 'utf8');
  if (!t.includes('yousef@halqa.app') || !t.includes('not-an-email') || t.includes(`imported${n}`)) throw new Error(t);
});

await step('confirm creates the valid row only and reports every row', async () => {
  await dlg().getByRole('button', { name: 'إنشاء 1 حساب وإرسال روابط الإعداد' }).click();
  await dlg().getByText(/أُنشئ 1 · لم يُنشأ 2 · البريد: أُرسل 1/).waitFor();
  await dlg().getByRole('button', { name: 'تم' }).click();
  await p.getByRole('searchbox').first().fill(`مستورد ${n}`);
  await p.getByText(`طالب مستورد ${n}`).first().waitFor();
});

await step('the imported student received a password-setup email', async () => {
  const dir = process.env.EMAIL_FILE_PATH || '/tmp/halqa-mail';
  const hit = readdirSync(dir).some((f) => readFileSync(`${dir}/${f}`, 'utf8').includes(`imported${n}@example.com`));
  if (!hit) throw new Error('no email');
});

console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no page errors');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails || errs.length ? 1 : 0; await b.close();
