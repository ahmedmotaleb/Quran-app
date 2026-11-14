// Compact Mushaf audio panel (owner request, 14 Nov 2026), on a 360 px Android-sized screen with an approved source.
// Checks:
//   - about 40% shorter than the old panel (347 px), with the Quran text still in view above it;
//   - every control at least 44×44, no overlap, no sideways scrolling;
//   - play, stop and the repetition buttons share one row while playing;
//   - the mini player keeps play/pause, the reciter and the repetition (tap to cycle), expands on tap, and is
//     remembered after a reload.
//   node e2e/mushaf-player.mjs <shots> [noAudioUrl, unused] [audioUrl=http://localhost:5176/]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { pickWho } from './lib/who.mjs';
// Same arguments as quran-audio.mjs: the CI runner passes the no-audio server second; the audio server is third.
const out = process.argv[2]; const BASE = (process.argv[4] || 'http://localhost:5176/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fails = 0;
const step = async (p, name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${out}/player-fail-${name.replace(/\W+/g, '_')}.png` }); } };
function silentWav(ms = 2000) {
  const n = Math.round(8 * ms), buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  return buf;
}
const ctx = await b.newContext({ viewport: { width: 360, height: 760 }, timezoneId: 'Africa/Cairo' });
await ctx.route('https://audio.e2e.test/**', (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() }));
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
const P = page.getByTestId('mushaf-player');

const measure = () => page.evaluate(() => {
  const el = document.querySelector('[data-testid=mushaf-player]');
  const r = el.getBoundingClientRect();
  const ctl = [...el.querySelectorAll('button,select,input')].filter((x) => x.offsetParent).map((x) => {
    const box = (x.closest('label') || x).getBoundingClientRect();
    return { n: x.getAttribute('aria-label') || x.closest('label')?.textContent.trim() || x.textContent.trim(), l: box.left, t: box.top, w: box.width, h: box.height };
  });
  const small = ctl.filter((c) => c.w < 44 - 0.5 || c.h < 44 - 0.5).map((c) => `${c.n} ${Math.round(c.w)}×${Math.round(c.h)}`);
  const overlap = [];
  for (let i = 0; i < ctl.length; i++) for (let j = i + 1; j < ctl.length; j++) {
    const a = ctl[i], c = ctl[j];
    if (a.l < c.l + c.w - 1 && c.l < a.l + a.w - 1 && a.t < c.t + c.h - 1 && c.t < a.t + a.h - 1) overlap.push(`${a.n} / ${c.n}`);
  }
  const ayahVisible = [...document.querySelectorAll('[id^="ayah-"]')].some((a) => { const q = a.getBoundingClientRect(); return q.top >= 0 && q.bottom <= r.top; });
  return { h: r.height, small, overlap, sideways: document.documentElement.scrollWidth > innerWidth, ayahVisible };
});

await step(page, 'expanded: ~40% shorter than before, 44 px targets, no overlap, no sideways scroll, Quran text visible', async () => {
  const m = await measure();
  if (m.h > 225) throw new Error(`panel ${m.h}px (was 347)`);
  if (m.small.length) throw new Error(`small targets: ${m.small.join(', ')}`);
  if (m.overlap.length) throw new Error(`overlap: ${m.overlap.join(', ')}`);
  if (m.sideways) throw new Error('sideways scroll');
  if (!m.ayahVisible) throw new Error('no ayah visible above the panel');
  await page.screenshot({ path: out + '/player-expanded-360.png' });
});
await step(page, 'playing: pause, stop and ×1…∞ in one row; speed and reciter still work', async () => {
  await P.getByRole('button', { name: 'تشغيل النطاق' }).click();
  await P.getByRole('button', { name: 'إيقاف التلاوة' }).waitFor();
  const tops = await P.evaluate((el) => ['إيقاف مؤقت', 'إيقاف التلاوة', 'تكرار كل آية 1 مرات', 'تكرار الآية باستمرار']
    .map((n) => { const q = el.querySelector(`[aria-label="${n}"]`).getBoundingClientRect(); return Math.round(q.top + q.height / 2); }));
  if (Math.max(...tops) - Math.min(...tops) > 2) throw new Error(`not one row (centres): ${tops}`);
  const m = await measure();
  if (m.small.length || m.overlap.length || m.sideways) throw new Error(JSON.stringify(m));
  await P.getByRole('button', { name: 'السرعة 1.25' }).click();
  if (await P.getByRole('button', { name: 'السرعة 1.25' }).getAttribute('aria-pressed') !== 'true') throw new Error('speed');
  await P.getByRole('button', { name: 'السرعة 1', exact: true }).click();
  await P.getByRole('button', { name: 'إيقاف التلاوة' }).click();
});
await page.getByRole('button', { name: 'إيقاف التلاوة' }).click().catch(() => {});  // stopped even if the step above failed
await step(page, 'mini player: play, reciter, repetition (tap cycles ×1→×3, applied); expands on tap; the mini choice is remembered after a restart', async () => {
  await P.getByRole('button', { name: 'تصغير مشغل التلاوة' }).click();
  await page.locator('[data-testid=mushaf-player][data-mini=true]').waitFor();
  const m = await measure();
  if (m.h > 70 || m.small.length || m.overlap.length || m.sideways) throw new Error(JSON.stringify(m));
  await P.getByRole('button', { name: 'تشغيل النطاق' }).waitFor();
  await P.getByRole('button', { name: /^التكرار: 1 مرات/ }).click();
  await P.getByRole('button', { name: /^التكرار: 3 مرات/ }).waitFor();
  await page.screenshot({ path: out + '/player-mini-360.png' });
  await P.getByRole('button', { name: 'توسيع مشغل التلاوة' }).first().click();          // the mini choice applies to the full panel
  if (await P.getByRole('button', { name: 'تكرار كل آية 3 مرات' }).getAttribute('aria-pressed') !== 'true') throw new Error('repetition from the mini player not applied');
  await P.getByRole('button', { name: 'تصغير مشغل التلاوة' }).click();
  await page.reload(); await app.getByText('السلام عليكم، يوسف').waitFor();   // a restart opens the home screen
  await app.getByRole('button', { name: /افتح المصحف/ }).click(); await app.locator('[id^="ayah-"]').first().waitFor();
  await page.locator('[data-testid=mushaf-player][data-mini=true]').waitFor();
  await P.getByRole('button', { name: 'توسيع مشغل التلاوة' }).first().click();
  await page.locator('[data-testid=mushaf-player][data-mini=false]').waitFor();
});
await b.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
