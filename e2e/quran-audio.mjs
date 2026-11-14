// Ayah audio practice (pack prompt 21). Without an approved source (the default) the Mushaf plays nothing and says
// why. With one configured (the second API runs with AYAH_AUDIO_URL on a test host that this script answers with a
// short silent clip): each AYAH repeats ×3 before the next one (1 1 1 2 2 2), ∞ repeats the same ayah until stopped,
// the range loop restarts the range, pause/resume keeps the count, changing ×3 during playback applies at once, a
// manually chosen ayah starts a fresh count, speed sticks, a failing clip stops once (no retry loop), a reciter change
// carries on with the same ayah, and leaving the Mushaf stops it. Every real play() call is recorded in the page.
//   node e2e/quran-audio.mjs <shots> [noAudioUrl=http://localhost:5174/] [audioUrl=http://localhost:5176/]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { pickWho } from './lib/who.mjs';
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
// What the reader hears: every play() of an <audio>, with its file, where in the clip it started and the speed.
const hookPlay = (ctx) => ctx.addInitScript(() => {
  window.__plays = [];
  const orig = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__plays.push({ f: this.src.split('/').slice(-2).join('/'), t: this.currentTime, r: this.playbackRate }); return orig.call(this); };
});
async function reader(base, ms = 150) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
  await hookPlay(ctx);
  const played = []; const R0 = { fail: null };
  const wav = silentWav(ms);
  await ctx.route('https://audio.e2e.test/**', (r) => {
    const f = new URL(r.request().url()).pathname.split('/').pop(); played.push(f);
    return R0.fail && f.endsWith(R0.fail) ? r.fulfill({ status: 404, body: '' }) : r.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
  });
  const page = await ctx.newPage(); page.setDefaultTimeout(10000);
  const app = page.locator('main#scr');
  if ((await (await page.request.get(base + 'api/ready')).json()).features?.quran_text !== 'imported') return null;
  await page.goto(base); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await pickWho(app, 'yousef@halqa.app'); await app.locator('#lg-email').fill('yousef@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
  await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
  await app.getByText('السلام عليكم، يوسف').waitFor();
  await app.getByRole('button', { name: /افتح المصحف/ }).click();
  await app.locator('[id^="ayah-"]').first().waitFor();
  return { page, app, played, R0 };
}
const playBtn = (R) => R.page.getByRole('button', { name: 'تشغيل النطاق' });
const repBtn = (R, n) => R.page.getByRole('button', { name: n ? `تكرار كل آية ${n} مرات` : 'تكرار الآية باستمرار' });
const status = (R) => R.page.getByTestId('recital-status');
/** Ayah numbers of each play that started a clip from the beginning (a resume after a pause is not a new play). */
const starts = async (R) => (await R.page.evaluate(() => window.__plays)).filter((x) => x.t < 0.05).map((x) => +x.f.slice(-7, -4));
const clearPlays = (R) => R.page.evaluate(() => { window.__plays.length = 0; });
const waitPlays = async (R, n) => { for (let i = 0; i < 100 && (await starts(R)).length < n; i++) await R.page.waitForTimeout(100); };
const stopBtn = (R) => R.page.getByRole('button', { name: 'إيقاف التلاوة' });
// The settings are a bottom sheet (closed by Play and when the Mushaf opens): open it before changing a setting.
const openSettings = async (R) => {
  const t = R.page.getByRole('button', { name: 'توسيع مشغل التلاوة' });
  if (await t.isVisible()) { await t.click(); await R.page.locator('[data-testid=mushaf-player][data-open=true]').waitFor(); await R.page.waitForTimeout(300); }
};
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
await step(R.page, '×3: the SAME ayah plays three complete times before the next one (1 1 1 2 2 2), then stops', async () => {
  await rangeTo(R, 2); await clearPlays(R);
  await openSettings(R); await repBtn(R, 3).click();
  if (await repBtn(R, 3).getAttribute('aria-pressed') !== 'true') throw new Error('×3 not selected');
  await playBtn(R).click();
  await stopBtn(R).waitFor();
  await playBtn(R).waitFor({ timeout: 15000 });   // back to "play" when done
  const got = await starts(R);
  if (got.join() !== '1,1,1,2,2,2') throw new Error('played ' + got.join(' '));
});
await step(R.page, '×1 and ×5 follow the same rule', async () => {
  for (const [n, want] of [[1, '1,2'], [5, '1,1,1,1,1,2,2,2,2,2']]) {
    await clearPlays(R); await openSettings(R); await repBtn(R, n).click(); await playBtn(R).click();
    await stopBtn(R).waitFor(); await playBtn(R).waitFor({ timeout: 20000 });
    const got = await starts(R); if (got.join() !== want) throw new Error(`×${n} played ${got.join(' ')}`);
  }
});
await step(R.page, '∞ repeats the current ayah until stopped, never moving on', async () => {
  await clearPlays(R);
  await openSettings(R); await repBtn(R, 0).click();
  await playBtn(R).click();
  await status(R).getByText('مستمر', { exact: false }).waitFor();
  await waitPlays(R, 6);
  const got = await starts(R);
  if (got.length < 6 || new Set(got).size !== 1 || got[0] !== 1) throw new Error('played ' + got.join(' '));
  await stopBtn(R).click();
  const n = (await starts(R)).length; await R.page.waitForTimeout(800);
  if ((await starts(R)).length !== n) throw new Error('kept playing after stop');
});
await step(R.page, 'range loop with ×3: the range restarts and each ayah still plays three times', async () => {
  await clearPlays(R);
  await openSettings(R); await repBtn(R, 3).click();
  await openSettings(R); await R.page.getByLabel('إعادة النطاق من البداية').check();
  await playBtn(R).click(); await waitPlays(R, 8);
  await stopBtn(R).click();
  const got = (await starts(R)).slice(0, 8);
  if (got.join() !== '1,1,1,2,2,2,1,1') throw new Error('played ' + got.join(' '));
  await openSettings(R); await R.page.getByLabel('إعادة النطاق من البداية').uncheck();
});
await step(R.page, 'speed choice sticks for every repetition, and carrying on past the range', async () => {
  await clearPlays(R);
  await openSettings(R); await R.page.getByRole('button', { name: 'السرعة 1.25' }).click();
  if (await R.page.getByRole('button', { name: 'السرعة 1.25' }).getAttribute('aria-pressed') !== 'true') throw new Error('speed not selected');
  await openSettings(R); await repBtn(R, 1).click();
  await openSettings(R); await R.page.getByLabel('متابعة بعد نهاية النطاق').check();
  await playBtn(R).click();
  await waitPlays(R, 4);
  const got = await starts(R);
  if (got.slice(0, 4).join() !== '1,2,3,4') throw new Error('played ' + got.join(' '));
  await status(R).getByText('متابعة بعد النطاق', { exact: false }).waitFor();
  const rates = (await R.page.evaluate(() => window.__plays)).map((x) => x.r);
  if (!rates.every((r) => r === 1.25)) throw new Error('rates ' + rates.join(' '));
  await stopBtn(R).click();
  await openSettings(R); await R.page.getByLabel('متابعة بعد نهاية النطاق').uncheck();
});
await step(R.page, 'leaving the Mushaf stops the recitation', async () => {
  await openSettings(R); await repBtn(R, 0).click(); await playBtn(R).click(); await waitPlays(R, 1);
  await R.page.getByRole('button', { name: 'رجوع' }).first().click();
  const n = (await starts(R)).length; await R.page.waitForTimeout(1000);
  if ((await starts(R)).length > n + 1) throw new Error('audio continued after leaving');
});
// Pause/resume, changing ×3 while playing, a manually chosen ayah, and a failing clip: a 1.5 s clip so the test can act
// in the middle of an ayah.
const P = await reader(ON, 1500);
await step(P.page, 'pause keeps the ayah, the place in it and the count; resume carries on; nothing advances while paused', async () => {
  await rangeTo(P, 1); await clearPlays(P);
  await openSettings(P); await repBtn(P, 3).click(); await playBtn(P).click();
  await waitPlays(P, 2);                                   // second play of ayah 1
  await P.page.waitForTimeout(400);
  await P.page.getByRole('button', { name: 'إيقاف مؤقت' }).click();
  await status(P).getByText('التكرار 2 من 3', { exact: false }).waitFor();
  await P.page.waitForTimeout(2500);
  if ((await starts(P)).length !== 2) throw new Error('advanced while paused: ' + (await starts(P)).join(' '));
  await P.page.getByRole('button', { name: 'متابعة التلاوة' }).click();
  const resumed = (await P.page.evaluate(() => window.__plays)).at(-1);
  if (!(resumed.t > 0.2)) throw new Error('resume restarted the clip: ' + JSON.stringify(resumed));
  await playBtn(P).waitFor({ timeout: 15000 });
  if ((await starts(P)).join() !== '1,1,1') throw new Error('played ' + (await starts(P)).join(' '));
});
await step(P.page, 'changing ×3 to ×1 during playback applies when the ayah ends', async () => {
  await rangeTo(P, 2); await clearPlays(P);
  await openSettings(P); await repBtn(P, 3).click(); await playBtn(P).click();
  await waitPlays(P, 1); await openSettings(P); await repBtn(P, 1).click();
  await playBtn(P).waitFor({ timeout: 15000 });
  if ((await starts(P)).join() !== '1,2') throw new Error('played ' + (await starts(P)).join(' '));
});
await step(P.page, 'choosing another ayah while repeating starts a fresh count there', async () => {
  await clearPlays(P);
  await openSettings(P); await repBtn(P, 0).click(); await playBtn(P).click();
  await waitPlays(P, 2);
  await P.app.locator('#ayah-3').click();
  await P.page.getByRole('button', { name: 'استمع من هذه الآية' }).click();
  await status(P).getByText('الآية 3 · التكرار 1 · مستمر').waitFor();
  await waitPlays(P, 4);
  const got = await starts(P);
  if (got.slice(2).some((a) => a !== 3)) throw new Error('played ' + got.join(' '));
  await stopBtn(P).click();
});
await step(P.page, 'a clip that fails to load stops the recitation once and says so (no retry loop)', async () => {
  await rangeTo(P, 1); await clearPlays(P);
  P.R0.fail = '005.mp3';
  await P.app.locator('#ayah-5').click();
  await P.page.getByRole('button', { name: 'استمع من هذه الآية' }).click();
  await P.page.getByText('تعذّر تشغيل الصوت', { exact: false }).waitFor();
  await playBtn(P).waitFor();
  const n = P.played.filter((f) => f.endsWith('005.mp3')).length; await P.page.waitForTimeout(2000);
  const m = P.played.filter((f) => f.endsWith('005.mp3')).length;
  if (m !== n || m > 3) throw new Error(`requested ${m} times`);
  P.R0.fail = null;
});

// Licensed source (Quran Foundation): the server hands out one surah's ayah URLs; the Mushaf loads them when the surah
// opens and plays from them. Quran Foundation is not reachable from CI, so this browser gets the server's answers
// from route stubs (settings say provider "qf"; quran/audio/<n> lists URLs on the test host).
const Q = await (async () => {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Africa/Cairo' });
  await hookPlay(ctx);
  const played = []; const asked = [];
  await ctx.route('https://audio.e2e.test/**', (r) => { const p = new URL(r.request().url()).pathname.split('/'); played.push(`${p.at(-2)}/${p.at(-1)}`); return r.fulfill({ status: 200, contentType: 'audio/wav', body: WAV }); });
  const RECITERS = [{ id: 12, name: 'محمود خليل الحصري — المصحف المعلم' }, { id: 7, name: 'مشاري راشد العفاسي' }];
  await ctx.route('**/api/v1/settings/public', async (r) => { const res = await r.fetch(); const j = await res.json(); j.ayah_audio = { provider: 'qf', name: 'Quran.com', url: '', default: 12, reciters: RECITERS }; return r.fulfill({ response: res, json: j }); });
  await ctx.route('**/api/v1/quran/audio/**', (r) => {
    const u = new URL(r.request().url()); const n = Number(u.pathname.split('/').pop()); const rid = Number(u.searchParams.get('reciter') || 12); asked.push(`${rid}:${n}`);
    const ayahs = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [String(i + 1), `https://audio.e2e.test/qf/r${rid}/${String(n).padStart(3, '0')}${String(i + 1).padStart(3, '0')}.mp3`]));
    return r.fulfill({ json: { surah: n, reciter_id: rid, reciter: RECITERS.find((x) => x.id === rid).name, source: 'Quran.com (Quran Foundation)', ayahs } });
  });
  const page = await ctx.newPage(); page.setDefaultTimeout(10000);
  const app = page.locator('main#scr');
  await page.goto(OFF); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
  await pickWho(app, 'yousef@halqa.app'); await app.locator('#lg-email').fill('yousef@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
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
  const s = Q.asked[0].split(':')[1].padStart(3, '0');
  if (Q.played.join() !== `r12/${s}001.mp3,r12/${s}002.mp3`) throw new Error('played ' + Q.played.join(' '));  // Husary (Muallim) by default
  await Q.app.getByText('الحصري — المصحف المعلم', { exact: false }).first().waitFor();
});
await step(Q.page, 'choosing another reciter plays that recitation and is remembered on the device', async () => {
  await openSettings(Q); await Q.page.getByRole('combobox', { name: 'القارئ' }).selectOption({ label: 'مشاري راشد العفاسي' });
  Q.played.length = 0;
  await playBtn(Q).click(); await stopBtn(Q).waitFor(); await playBtn(Q).waitFor({ timeout: 15000 });
  if (!Q.played.length || !Q.played.every((x) => x.startsWith('r7/'))) throw new Error('played ' + Q.played.join(' '));
  await Q.page.reload(); await Q.app.locator('[id^="ayah-"]').first().waitFor().catch(() => {});
  const v = await Q.page.evaluate(() => localStorage.getItem('halqa.reciter'));
  if (v !== '7') throw new Error('choice not remembered: ' + v);
});
await step(Q.page, 'changing the reciter while an ayah repeats carries on with the same ayah and the same count', async () => {
  if (!(await Q.app.locator('[id^="ayah-"]').count())) {
    await Q.app.getByText('السلام عليكم، يوسف').waitFor(); await Q.app.getByRole('button', { name: /افتح المصحف/ }).click();
  }
  await Q.app.locator('[id^="ayah-"]').first().waitFor();
  await clearPlays(Q);
  await openSettings(Q); await repBtn(Q, 0).click(); await playBtn(Q).click();
  await waitPlays(Q, 3);
  await openSettings(Q); await Q.page.getByRole('combobox', { name: 'القارئ' }).selectOption({ label: 'محمود خليل الحصري — المصحف المعلم' });
  await waitPlays(Q, 6);
  const all = (await Q.page.evaluate(() => window.__plays)).filter((x) => x.t < 0.05).map((x) => x.f);
  const at = all.findIndex((f) => f.startsWith('r12/'));
  if (at < 3 || !all.slice(0, at).every((f) => f.startsWith('r7/')) || new Set(all.map((f) => f.slice(-7))).size !== 1) throw new Error('played ' + all.join(' '));
  await status(Q).getByText('مستمر', { exact: false }).waitFor();
  await stopBtn(Q).click();
});
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
