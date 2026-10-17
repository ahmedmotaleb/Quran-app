// Ayah audio practice (pack prompt 21). Without an approved source (the default) the Mushaf plays nothing and says
// why. With one configured (the second API runs with AYAH_AUDIO_URL on a test host that this script answers with a
// short silent clip), the range plays in order, repeats ×3, repeats continuously, carries on past the range when
// asked, and stops when the reader leaves the Mushaf.
//   node e2e/quran-audio.mjs <shots> [noAudioUrl=http://localhost:5174/] [audioUrl=http://localhost:5176/]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2];
const OFF = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const ON = (process.argv[4] || 'http://localhost:5176/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${out}/quran-audio-fail-${name.replace(/\W+/g, '_')}.png` }); } };

function silentWav(ms = 150) {  // 8 kHz mono 16-bit PCM
  const n = Math.round(8 * ms), buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  return buf;
}
const WAV = silentWav();
async function reader(base) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
  const played = [];
  await ctx.route('https://audio.e2e.test/**', (r) => { played.push(new URL(r.request().url()).pathname.split('/').pop()); return r.fulfill({ status: 200, contentType: 'audio/wav', body: WAV }); });
  const page = await ctx.newPage(); page.setDefaultTimeout(10000);
  const app = page.locator('main#scr');
  if ((await (await page.request.get(base + 'api/ready')).json()).features?.quran_text !== 'imported') return null;
  await page.goto(base); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.locator('#lg-email').fill('yousef@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText('السلام عليكم، يوسف').waitFor();
  await app.getByRole('button', { name: /افتح المصحف/ }).click();
  await app.locator('[id^="ayah-"]').first().waitFor();
  return { page, app, played };
}
const playBtn = (R) => R.page.getByRole('button', { name: 'تشغيل النطاق' });
const stopBtn = (R) => R.page.getByRole('button', { name: 'إيقاف التلاوة' });
async function rangeTo(R, to) {  // the range starts at 1..10; shrink it to 1 (the minimum) and grow it back to `to`
  for (let i = 0; i < 10; i++) await R.page.getByRole('button', { name: 'نهاية النطاق ناقص' }).click();
  for (let i = 1; i < to; i++) await R.page.getByRole('button', { name: 'نهاية النطاق زائد' }).click();
}
const surahFile = (R) => R.played[0]?.slice(0, 3);

const A = await reader(OFF);
if (!A) { console.log('SKIPPED: no verified Quran text in this environment (CI imports it).'); await b.close(); process.exit(0); }
await step(A.page, 'without an approved source nothing plays and the reader is told why', async () => {
  if (!(await playBtn(A).isDisabled())) throw new Error('play is enabled');
  await A.app.getByText('التلاوة الصوتية متوقفة حتى اعتماد مصدر مرخّص.', { exact: false }).waitFor();
  if (await A.page.getByRole('group', { name: 'سرعة التلاوة' }).count()) throw new Error('speed controls shown without audio');
});

const R = await reader(ON);
await step(R.page, 'the range plays in order three times, then stops', async () => {
  await rangeTo(R, 2);
  await R.page.getByRole('button', { name: 'تكرار 3 مرات' }).click();
  await playBtn(R).click();
  await stopBtn(R).waitFor();
  await playBtn(R).waitFor({ timeout: 15000 });   // back to "play" when done
  const s = surahFile(R);
  const want = [1, 2, 1, 2, 1, 2].map((a) => s + String(a).padStart(3, '0') + '.mp3');
  if (JSON.stringify(R.played) !== JSON.stringify(want)) throw new Error('played ' + R.played.join(' '));
});
await step(R.page, 'continuous repeat keeps going until stopped', async () => {
  R.played.length = 0;
  await rangeTo(R, 1);
  await R.page.getByRole('button', { name: 'تكرار مستمر' }).click();
  await playBtn(R).click();
  await R.page.waitForFunction(() => document.body.textContent.includes('مستمر'));
  for (let i = 0; i < 60 && R.played.length < 5; i++) await R.page.waitForTimeout(100);
  if (R.played.length < 5 || new Set(R.played).size !== 1) throw new Error('played ' + R.played.join(' '));
  await stopBtn(R).click();
  const n = R.played.length; await R.page.waitForTimeout(800);
  if (R.played.length !== n) throw new Error('kept playing after stop');
});
await step(R.page, 'speed choice and carrying on past the range', async () => {
  R.played.length = 0;
  await R.page.getByRole('button', { name: 'السرعة 1.25' }).click();
  if (await R.page.getByRole('button', { name: 'السرعة 1.25' }).getAttribute('aria-pressed') !== 'true') throw new Error('speed not selected');
  await R.page.getByRole('button', { name: 'تكرار 1 مرات' }).click();
  await R.page.getByLabel('متابعة بعد نهاية النطاق').check();
  await playBtn(R).click();
  for (let i = 0; i < 60 && R.played.length < 4; i++) await R.page.waitForTimeout(100);
  const nums = R.played.map((f) => +f.slice(3, 6));
  if (nums.slice(0, 4).join() !== '1,2,3,4') throw new Error('played ' + R.played.join(' '));
  await R.app.getByText('متابعة بعد النطاق').waitFor();
});
await step(R.page, 'leaving the Mushaf stops the recitation', async () => {
  await R.page.getByRole('button', { name: 'رجوع' }).first().click();
  const n = R.played.length; await R.page.waitForTimeout(1000);
  if (R.played.length > n + 1) throw new Error('audio continued after leaving');
});
// Licensed source (Quran Foundation): the server hands out one surah's ayah URLs; the Mushaf loads them when the surah
// opens and plays from them. Quran Foundation is not reachable from CI, so this browser gets the server's answers
// from route stubs (settings say provider "qf"; quran/audio/<n> lists URLs on the test host).
const Q = await (async () => {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
  const played = []; const asked = [];
  await ctx.route('https://audio.e2e.test/**', (r) => { played.push(new URL(r.request().url()).pathname.split('/').pop()); return r.fulfill({ status: 200, contentType: 'audio/wav', body: WAV }); });
  await ctx.route('**/api/v1/settings/public', async (r) => { const res = await r.fetch(); const j = await res.json(); j.ayah_audio = { provider: 'qf', name: 'مشاري راشد العفاسي · Quran.com', url: '' }; return r.fulfill({ response: res, json: j }); });
  await ctx.route('**/api/v1/quran/audio/*', (r) => {
    const n = Number(r.request().url().split('/').pop()); asked.push(n);
    const ayahs = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [String(i + 1), `https://audio.e2e.test/qf/${String(n).padStart(3, '0')}${String(i + 1).padStart(3, '0')}.mp3`]));
    return r.fulfill({ json: { surah: n, reciter: 'مشاري راشد العفاسي', source: 'Quran.com (Quran Foundation)', ayahs } });
  });
  const page = await ctx.newPage(); page.setDefaultTimeout(10000);
  const app = page.locator('main#scr');
  await page.goto(OFF); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await app.locator('#lg-email').fill('yousef@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText('السلام عليكم، يوسف').waitFor();
  await app.getByRole('button', { name: /افتح المصحف/ }).click();
  await app.locator('[id^="ayah-"]').first().waitFor();
  return { page, app, played, asked };
})();
await step(Q.page, 'Quran Foundation source: the surah audio list loads on open and the range plays from it', async () => {
  await Q.app.getByText('Quran.com', { exact: false }).first().waitFor();
  for (let i = 0; i < 30 && !Q.asked.length; i++) await Q.page.waitForTimeout(100);
  if (!Q.asked.length) throw new Error('surah audio list not requested on open');
  for (let i = 0; i < 10; i++) await Q.page.getByRole('button', { name: 'نهاية النطاق ناقص' }).click();
  await Q.page.getByRole('button', { name: 'نهاية النطاق زائد' }).click();
  await playBtn(Q).click();
  await stopBtn(Q).waitFor();
  await playBtn(Q).waitFor({ timeout: 15000 });
  const s = String(Q.asked[0]).padStart(3, '0');
  if (Q.played.join() !== `${s}001.mp3,${s}002.mp3`) throw new Error('played ' + Q.played.join(' '));
});
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
