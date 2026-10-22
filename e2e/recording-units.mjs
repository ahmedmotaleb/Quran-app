// Recording pipeline, module level, in a real browser (Chromium + fake microphone): format negotiation, file names,
// multipart body, the real MediaRecorder output, IndexedDB copies per account, error mapping for non-JSON responses,
// and retry-safe uploads (X-Upload-ID). Needs the dev server (imports /src modules) and the API for the upload checks.
//   node e2e/recording-units.mjs <shots> [base-url]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2]; const BASE = (process.argv[3] || 'http://localhost:5174/').replace(/\/?$/, '/');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const ctx = await b.newContext({ permissions: ['microphone'] });
const page = await ctx.newPage(); page.setDefaultTimeout(15000);
let fails = 0;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message.split('\n')[0]); } };
const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
await page.goto(BASE);
const ev = (fn, arg) => page.evaluate(fn, arg);

await step('format negotiation: WebM/Opus, MP4, Ogg, none', async () => {
  const r = await ev(async () => {
    const m = await import('/src/services/media.ts');
    const only = (...ok) => (t) => ok.includes(t);
    return [m.pickRecordingType(only('audio/webm;codecs=opus', 'audio/mp4')), m.pickRecordingType(only('audio/mp4')),
      m.pickRecordingType(only('audio/ogg;codecs=opus')), m.pickRecordingType(only('audio/webm')), m.pickRecordingType(() => false),
      m.pickRecordingType()];
  });
  eq(r.slice(0, 5), ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm', null], 'pick');
  if (r[5] !== 'audio/webm;codecs=opus') throw new Error('this Chromium should record WebM/Opus, got ' + r[5]);
});
await step('file names follow the real type', async () => {
  const r = await ev(async () => {
    const m = await import('/src/services/media.ts');
    return ['audio/webm;codecs=opus', 'audio/mp4', 'audio/x-m4a', 'audio/ogg;codecs=opus', 'audio/aac', 'audio/mpeg', 'audio/wav', 'video/mp4', '']
      .map((t) => [m.fileNameFor(t), m.serverAccepts(t)]);
  });
  eq(r, [['recitation.webm', true], ['recitation.m4a', true], ['recitation.m4a', true], ['recitation.ogg', true], ['recitation.aac', true],
    ['recitation.mp3', true], ['recitation.wav', true], ['recitation.bin', false], ['recitation.bin', false]], 'names');
});
await step('multipart part keeps the real type and a matching name (no File constructor needed)', async () => {
  const r = await ev(async () => {
    const E = await import('/src/api/endpoints.ts');
    const typed = E.audioForm(new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'audio/webm;codecs=opus' }), '', 12.4, 'recitation');
    const untyped = E.audioForm(new Blob([new Uint8Array([0, 0, 0, 0x1c])]), 'audio/mp4', 30, 'recitation');
    const f1 = typed.get('file'); const f2 = untyped.get('file');
    return [f1.name, f1.type, typed.get('duration_seconds'), f2.name, f2.type, f2.size];
  });
  eq(r, ['recitation.webm', 'audio/webm;codecs=opus', '12', 'recitation.m4a', 'audio/mp4', 4], 'form');
});
await step('real MediaRecorder output: WebM/Opus bytes, type recorded, non-empty', async () => {
  const r = await ev(async () => {
    const m = await import('/src/services/media.ts');
    await new Promise((res, rej) => { m.startRecorder(res).catch(rej); setTimeout(() => m.stopRecorder(), 1500); });
    const head = new Uint8Array(await m.recording.blob.slice(0, 4).arrayBuffer());
    const out = { mime: m.recording.mime, type: m.recording.blob.type, size: m.recording.blob.size, head: Array.from(head), url: !!m.recording.url };
    m.discardRecorder();
    return out;
  });
  if (!r.mime.startsWith('audio/webm') || r.type !== r.mime || r.size < 500 || !r.url) throw new Error(JSON.stringify(r));
  eq(r.head, [0x1a, 0x45, 0xdf, 0xa3], 'EBML magic');
});
await step('IndexedDB copy: per account, update, list, delete, expiry', async () => {
  const r = await ev(async () => {
    const P = await import('/src/services/pendingRec.ts');
    const blob = new Blob([new Uint8Array(2000)], { type: 'audio/webm' });
    const base = { blob, mime: 'audio/webm', secs: 25, state: 'ready', uploadId: 'u-12345678', idemKey: 'k-12345678', mediaId: null };
    await P.savePending({ ...base, userId: '7', taskId: '11', createdAt: Date.now() });
    await P.savePending({ ...base, userId: '7', taskId: '12', createdAt: Date.now() - 8 * 86400_000 }); // older than 7 days
    await P.savePending({ ...base, userId: '9', taskId: '11', createdAt: Date.now() });
    const mine = await P.listPending('7'); const other = await P.listPending('9');
    const back = await P.getPending('7', '11'); const size = back && back.blob.size;
    await P.updatePending('7', '11', { state: 'failed', mediaId: 'm1' });
    const upd = await P.getPending('7', '11');
    const cross = await P.getPending('9', '12');
    await P.deletePending('7', '11'); await P.deletePending('9', '11');
    return [mine.map((p) => p.taskId), other.length, size, upd.state, upd.mediaId, cross, (await P.listPending('7')).length];
  });
  eq(r, [['11'], 1, 2000, 'failed', 'm1', null, 0], 'pending');
});
await step('non-JSON errors: status-specific Arabic, request id, safe diagnostics', async () => {
  const r = await ev(async () => {
    const C = await import('/src/api/client.ts');
    return [C.nonJsonMessage(413, '', true), C.nonJsonMessage(502, 'abcdef1234567890', true), C.nonJsonMessage(404, 'rid1', false),
      C.endpointCategory('/api/v1/assignments/123/submissions'), C.endpointCategory('/api/v1/assignments/NaN/submissions')];
  });
  eq(r[0], 'حجم التسجيل أكبر من الحد المسموح.', '413');
  if (!r[1].includes('رقم الخطأ: abcdef123456') || !r[1].includes('رفع التسجيل')) throw new Error('502: ' + r[1]);
  if (!r[2].includes('rid1')) throw new Error('404: ' + r[2]);
  eq(r.slice(3), ['assignments/:id/submissions', 'assignments/NaN/submissions'], 'category');
});

// Upload error mapping and retries against routed responses (the dev server proxies /api to Django).
const login = await page.request.post(BASE + 'api/v1/auth/login', { data: { email: 'yousef@halqa.app', password: 'halqa123' } });
if (!login.ok()) { fails++; console.log('FAIL student sign-in', login.status()); }
const uploadWith = (body) => ev(async ({ body }) => {
  const E = await import('/src/api/endpoints.ts'); const L = await import('/src/store/live.ts');
  try {
    const blob = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(3000).fill(0)])], { type: 'audio/webm' });
    const r = await E.uploadRecitation(blob, 25, { uploadId: body.uploadId });
    return { ok: true, id: r.id };
  } catch (e) { return { ok: false, status: e.status, code: e.code, msg: L.uploadError(e), rid: e.requestId }; }
}, { body });
const route = async (fn) => { await page.route('**/api/v1/media/recitations', fn); };
for (const [name, handler, expect] of [
  ['HTML 502 from a proxy', (r) => r.fulfill({ status: 502, contentType: 'text/html', headers: { 'X-Request-ID': 'req-502-abc' }, body: '<html>Bad Gateway</html>' }), (x) => x.code === 'http_502' && x.msg.includes('رقم الخطأ: req-502-abc')],
  ['HTML 413 from the load balancer', (r) => r.fulfill({ status: 413, contentType: 'text/html', body: '<html>Too large</html>' }), (x) => x.msg === 'حجم التسجيل أكبر من الحد المسموح.'],
  ['JSON 503 storage', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'storage_unavailable', message: 'x' }) }), (x) => x.msg.startsWith('تعذّر حفظ التسجيل على الخادم')],
  ['JSON 400 invalid file', (r) => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'invalid_file', message: 'x' }) }), (x) => x.msg === 'صيغة التسجيل التي أنشأها جهازك غير مدعومة بعد.'],
  ['network failure', (r) => r.abort('internetdisconnected'), (x) => x.code === 'network' && x.msg.includes('التسجيل محفوظ')],
]) {
  await step(`upload error: ${name}`, async () => {
    await route(handler);
    const x = await uploadWith({ uploadId: 'unit-' + Date.now() });
    await page.unroute('**/api/v1/media/recitations');
    if (x.ok || !expect(x)) throw new Error(JSON.stringify(x));
  });
}
await step('timeout message', async () => {
  const m = await ev(async () => { const L = await import('/src/store/live.ts'); const C = await import('/src/api/client.ts'); return L.uploadError(new C.ApiError(0, 'timeout', '')); });
  if (!m.startsWith('استغرق رفع التسجيل وقتًا طويلًا')) throw new Error(m);
});
await step('retry after a lost response reuses the stored copy (same X-Upload-ID, one object)', async () => {
  const seen = []; let first = true;
  await route(async (r) => {
    seen.push(r.request().headers()['x-upload-id']);
    const resp = await r.fetch();               // the server stores it…
    if (first) { first = false; return r.abort('connectionreset'); } // …but the answer is lost on the way back
    return r.fulfill({ response: resp });
  });
  const key = 'unit-retry-' + Date.now();
  const x = await uploadWith({ uploadId: key });
  await page.unroute('**/api/v1/media/recitations');
  const again = await uploadWith({ uploadId: key });
  if (!x.ok || !again.ok || x.id !== again.id || seen.length < 2 || seen.some((k) => k !== key)) throw new Error(JSON.stringify({ x, again, seen }));
});
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
