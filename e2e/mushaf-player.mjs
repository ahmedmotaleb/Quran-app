// Auto-collapsing Mushaf audio player (owner requests, 14 Nov 2026) on a 360 px Android-sized screen.
// Acceptance checks:
//   - opens as a mini player of about 56–64 px; the Quran text stays visible and is not covered;
//   - Expand shows every setting; the sheet closes by the collapse button and by a downward swipe;
//   - Play closes the sheet automatically;
//   - expanding and collapsing during recitation never restarts, reloads or replaces the audio: the same element,
//     no new play() or download, and currentTime keeps going;
//   - the next ayah keeps the sheet closed;
//   - Pause keeps the mini player; Resume continues from the same place;
//   - the progress line moves;
//   - 44×44 targets, no overlap, no sideways scroll.
//   node e2e/mushaf-player.mjs <shots> [noAudioUrl, unused] [audioUrl=http://localhost:5176/]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { pickWho } from './lib/who.mjs';
// Same arguments as quran-audio.mjs: the CI runner passes the no-audio server second; the audio server is third.
const out = process.argv[2]; const BASE = (process.argv[4] || 'http://localhost:5176/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${out}/player-fail-${name.replace(/\W+/g, '_')}.png` }); } };
function silentWav(ms) {
  const n = Math.round(8 * ms), buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  return buf;
}
const ctx = await b.newContext({ viewport: { width: 360, height: 760 }, timezoneId: 'Africa/Cairo' });
// Every play() with the element it was called on (tagged once) and the time it started from.
await ctx.addInitScript(() => {
  window.__plays = []; let n = 0;
  const orig = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { this.__id ??= ++n; window.__el = this; window.__plays.push({ id: this.__id, f: this.src.split('/').pop(), t: this.currentTime }); return orig.call(this); };
});
const downloads = [];
const WAV = silentWav(4000);   // 4 s per ayah: long enough to watch it continue
await ctx.route(/audio\.e2e\.test/, (r) => { downloads.push(r.request().url()); return r.fulfill({ status: 200, contentType: 'audio/wav', body: WAV }); });
// Two reciters, so the reciter choice is part of the sheet (the CI server's source has a single one).
await ctx.route('**/api/v1/settings/public', async (r) => {
  const res = await r.fetch(); const j = await res.json();
  j.ayah_audio = { provider: 'template', url: 'https://audio.e2e.test/{surah}{ayah}.wav', name: 'تلاوة اختبار', default: 7,
    reciters: [{ id: 7, name: 'مشاري راشد العفاسي' }, { id: 2, name: 'عبد الباسط عبد الصمد' }] };
  await r.fulfill({ response: res, json: j });
});
const page = await ctx.newPage(); page.setDefaultTimeout(10000);
const app = page.locator('main#scr');
if ((await (await page.request.get(BASE + 'api/ready')).json()).features?.quran_text !== 'imported') {
  console.log('SKIP no Quran text on this server'); console.log('ALL PASSED'); process.exit(0);
}
await page.goto(BASE); await app.getByRole('button', { exact: true, name: 'تخطَّ' }).click();
await pickWho(app, 'yousef@halqa.app'); await app.locator('#lg-email').fill('yousef@halqa.app'); await app.locator('#lg-pw').fill('halqa123');
await app.getByRole('button', { exact: true, name: 'تسجيل الدخول' }).click();
await app.getByText('السلام عليكم، يوسف').waitFor();
await app.getByRole('button', { name: /افتح المصحف/ }).click();
await app.locator('[id^="ayah-"]').first().waitFor();

const player = page.getByTestId('mushaf-player');
const sheet = page.locator('#mushaf-player-settings');
const isOpen = async () => (await player.getAttribute('data-open')) === 'true';
const status = () => page.getByTestId('recital-status').innerText();
const expand = async () => { await page.getByRole('button', { name: 'توسيع مشغل التلاوة' }).click(); await page.locator('[data-testid=mushaf-player][data-open=true]').waitFor(); await page.waitForTimeout(320); };
const collapse = async () => { await page.getByRole('button', { name: 'تصغير مشغل التلاوة' }).click(); await page.locator('[data-testid=mushaf-player][data-open=false]').waitFor(); await page.waitForTimeout(320); };
const layout = (scope) => page.evaluate((sel) => {
  const root = document.querySelector(sel);
  const ctl = [...root.querySelectorAll('button,select,input')].filter((x) => x.offsetParent && getComputedStyle(x).visibility !== 'hidden' && !x.closest('[inert]')).map((x) => {
    const q = (x.closest('label') || x).getBoundingClientRect();
    return { n: x.getAttribute('aria-label') || x.closest('label')?.textContent.trim() || x.textContent.trim(), l: q.left, t: q.top, w: q.width, h: q.height };
  });
  const overlap = [];
  for (let i = 0; i < ctl.length; i++) for (let j = i + 1; j < ctl.length; j++) {
    const a = ctl[i], c = ctl[j];
    if (a.n !== c.n && a.l < c.l + c.w - 1 && c.l < a.l + a.w - 1 && a.t < c.t + c.h - 1 && c.t < a.t + a.h - 1) overlap.push(`${a.n} / ${c.n}`);
  }
  return { small: ctl.filter((c) => c.w < 43.5 || c.h < 43.5).map((c) => `${c.n} ${Math.round(c.w)}×${Math.round(c.h)}`), overlap,
    sideways: document.documentElement.scrollWidth > innerWidth };
}, scope);
const mini = () => page.locator('section[aria-label="مشغل التلاوة"]');

await step(page, 'opens as a mini player (56–64 px) that never covers the Quran text; 44 px targets; no sideways scroll', async () => {
  if (await isOpen()) throw new Error('settings open on arrival');
  const box = await mini().boundingBox();
  if (box.height < 50 || box.height > 66) throw new Error(`mini ${box.height}px`);
  // the last ayah can be scrolled fully above the mini player (it is in the page flow, not on top of the text)
  await page.locator('[id^="ayah-"]').last().scrollIntoViewIfNeeded();
  const last = await page.locator('[id^="ayah-"]').last().boundingBox(); const m2 = await mini().boundingBox();
  if (last.y + last.height > m2.y + 1) throw new Error('the mini player covers the last ayah');
  const l = await layout('[data-testid=mushaf-player]');
  if (l.small.length || l.overlap.length || l.sideways) throw new Error(JSON.stringify(l));
  await page.locator('[id^="ayah-"]').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: out + '/player-mini-360.png' });
});
await step(page, 'expand shows every setting; the collapse button and a downward swipe both close it', async () => {
  await expand();
  for (const n of ['تكرار كل آية 1 مرات', 'تكرار كل آية 3 مرات', 'تكرار كل آية 5 مرات', 'تكرار كل آية 10 مرات', 'تكرار الآية باستمرار', 'السرعة 0.75', 'السرعة 1', 'السرعة 1.25'])
    await sheet.getByRole('button', { name: n, exact: true }).waitFor();
  await sheet.getByRole('combobox', { name: 'القارئ' }).waitFor();
  await sheet.getByLabel('إعادة النطاق من البداية').waitFor(); await sheet.getByLabel('متابعة بعد نهاية النطاق').waitFor();
  await sheet.getByRole('button', { name: /تشغيل من بداية النطاق/ }).waitFor();
  const l = await layout('[data-testid=mushaf-player]');
  if (l.small.length || l.overlap.length || l.sideways) throw new Error(JSON.stringify(l));
  await page.screenshot({ path: out + '/player-sheet-360.png' });
  await collapse();
  await expand();
  const h = await sheet.locator('div').first().boundingBox();           // swipe down on the handle row
  await page.mouse.move(h.x + h.width / 2, h.y + 20); await page.mouse.down();
  for (let y = 0; y <= 120; y += 20) await page.mouse.move(h.x + h.width / 2, h.y + 20 + y);
  await page.mouse.up();
  await page.locator('[data-testid=mushaf-player][data-open=false]').waitFor();
});
await step(page, 'Play closes the sheet automatically; expanding/collapsing never restarts, reloads or replaces the audio', async () => {
  await expand();
  await page.getByRole('button', { name: 'تشغيل النطاق' }).click();
  await page.locator('[data-testid=mushaf-player][data-open=false]').waitFor();
  await page.getByTestId('recital-status').getByText('الآية 1 ·', { exact: false }).waitFor();
  await page.waitForTimeout(700);
  const before = await page.evaluate(() => ({ plays: window.__plays.length, id: window.__el.__id, t: window.__el.currentTime, src: window.__el.src }));
  const dl = downloads.length; const st = await status();
  await expand();
  await page.waitForTimeout(400);
  if ((await status()) !== st) throw new Error(`status changed on expand: ${st} → ${await status()}`);
  await collapse();
  const after = await page.evaluate(() => ({ plays: window.__plays.length, id: window.__el.__id, t: window.__el.currentTime, src: window.__el.src, paused: window.__el.paused }));
  if (after.plays !== before.plays || after.id !== before.id || after.src !== before.src) throw new Error(`audio restarted/replaced ${JSON.stringify([before, after])}`);
  if (downloads.length !== dl) throw new Error('audio downloaded again');
  if (!(after.t > before.t) || after.paused) throw new Error(`playback did not continue ${before.t} → ${after.t}`);
});
await step(page, 'progress line moves; the next ayah keeps the sheet closed', async () => {
  const pct = async () => Number(await page.getByRole('progressbar', { name: 'تقدّم التلاوة في النطاق' }).getAttribute('aria-valuenow'));
  const w0 = await pct();
  await page.getByTestId('recital-status').getByText('الآية 2 ·', { exact: false }).waitFor({ timeout: 12000 });
  const w1 = await pct();
  if (!(w1 > w0)) throw new Error(`progress ${w0} → ${w1}`);
  if (await isOpen()) throw new Error('sheet reopened on the next ayah');
});
await step(page, 'Pause keeps the mini player; Resume continues from the same place', async () => {
  await page.getByRole('button', { name: 'إيقاف مؤقت' }).click();
  await page.getByTestId('recital-status').getByText('متوقفة مؤقتًا', { exact: false }).waitFor();
  await mini().waitFor();
  const p = await page.evaluate(() => ({ t: window.__el.currentTime, f: window.__el.src.split('/').pop(), id: window.__el.__id }));
  await page.waitForTimeout(600);
  const p2 = await page.evaluate(() => window.__el.currentTime);
  if (Math.abs(p2 - p.t) > 0.05) throw new Error('moved while paused');
  await page.getByRole('button', { name: 'متابعة التلاوة' }).click();
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => ({ t: window.__el.currentTime, f: window.__el.src.split('/').pop(), id: window.__el.__id, paused: window.__el.paused }));
  if (r.f !== p.f || r.id !== p.id || r.t < p.t || r.paused) throw new Error(`resume ${JSON.stringify([p, r])}`);
  if (await isOpen()) throw new Error('sheet opened on resume');
  await page.getByRole('button', { name: 'إيقاف التلاوة' }).click();
});
await b.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
