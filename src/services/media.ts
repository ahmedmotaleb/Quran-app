/**
 * Browser media: the shared playback element, Mushaf ayah audio, and the real
 * microphone recorder (MediaRecorder). Uploads: demo mode simulates; live mode sends the blob (store.submitRec).
 */

/** The single <audio> used by every PlayerBar that has a real URL (recordings). */
export const playback: { el: HTMLAudioElement | null } = { el: null };

export function stopPlayback() {
  if (playback.el) playback.el.pause();
}
export function replacePlayback(url: string | null | undefined) {
  if (playback.el) playback.el.pause();
  playback.el = url ? new Audio(url) : null;
  playback.el?.play().catch(() => {});
}

/** Mushaf recitation audio, chained ayah-by-ayah by the store. */
export const mushafAudio: { el: HTMLAudioElement | null } = { el: null };
export function stopMushafAudio() {
  const a = mushafAudio.el;
  if (a) { a.onended = null; a.onerror = null; a.pause(); mushafAudio.el = null; }
}

/* ---------- Recorder ---------- */
/** Recording formats in order of preference. Only one the browser reports as supported is used, and only formats the
 *  server accepts (it checks the file's first bytes against the type). WebM/Opus first: Android Chrome produces it and
 *  it uploaded fine in production; MP4 next (Safari/iPhone); Ogg for Firefox. */
export const REC_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'] as const;
/** Types the server accepts (backend/apps/media/services.py AUDIO_TYPES) → file extension. */
export const EXT: Record<string, string> = {
  'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/ogg': 'ogg', 'audio/aac': 'aac',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
};
export const baseType = (mime: string) => (mime || '').split(';')[0].trim().toLowerCase();
export const serverAccepts = (mime: string) => baseType(mime) in EXT;
/** "recitation.webm", "recitation.m4a"… from the real type; never a made-up type. */
export const fileNameFor = (mime: string, stem = 'recitation') => `${stem}.${EXT[baseType(mime)] ?? 'bin'}`;

/** The first preferred format this browser can record, or null (then the browser's default is used and checked). */
export function pickRecordingType(supported: (t: string) => boolean = (t) => {
  try { return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t); } catch { return false; }
}): string | null {
  return REC_TYPES.find((t) => supported(t)) ?? null;
}

let mr: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
/** The last finished recording: object URL for local playback, the bytes, and the type the recorder really produced. */
export const recording: { url: string | null; blob: Blob | null; mime: string } = { url: null, blob: null, mime: '' };

/** True while the microphone is capturing (any screen that records, including quiz recitations). */
export function recorderActive() { return !!mr && mr.state !== 'inactive'; }

export function recorderSupported() {
  return typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof window.MediaRecorder !== 'undefined';
}

/** Requests the microphone and starts recording. Rejects when permission is denied or unsupported. */
export async function startRecorder(onStop: () => void) {
  discardRecorder();
  if (!recorderSupported()) throw new Error('unsupported');
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream = s; chunks = [];
  const wanted = pickRecordingType();
  let r: MediaRecorder;
  // 64 kb/s is plenty for a voice and keeps a 15-minute recitation near 7 MB (the default ~128 kb/s doubles the size
  // and the upload time on a weak mobile connection).
  try { r = new MediaRecorder(s, { ...(wanted ? { mimeType: wanted } : {}), audioBitsPerSecond: 64_000 }); }
  catch { r = new MediaRecorder(s); } // a type reported as supported but refused: the browser's default
  mr = r;
  r.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  r.onstop = () => {
    // The type the recorder actually used (some browsers report it only after starting), else the chunks' own type.
    const mime = r.mimeType || chunks[0]?.type || wanted || '';
    const b = new Blob(chunks, { type: mime });
    recording.url = b.size ? URL.createObjectURL(b) : null;
    recording.blob = b.size ? b : null;
    recording.mime = mime;
    s.getTracks().forEach((t) => t.stop());
    onStop();
  };
  r.start(); // one final chunk: the format proven on real Android uploads (timeslices are not needed)
}
/** Puts a saved recording (from this device's storage) back as the current one, for listening and sending. */
export function restoreRecording(blob: Blob, mime: string) {
  discardRecorder();
  recording.blob = blob; recording.mime = mime; recording.url = URL.createObjectURL(blob);
}
export function pauseRecorder() { try { mr?.pause(); } catch { /* ignore */ } }
export function resumeRecorder() { try { mr?.resume(); } catch { /* ignore */ } }
/** Returns true if a real recorder was stopped (its onStop will fire asynchronously). */
export function stopRecorder(): boolean {
  if (mr && mr.state !== 'inactive') { mr.stop(); return true; }
  return false;
}
export function discardRecorder() {
  try { if (mr && mr.state !== 'inactive') { mr.onstop = null; mr.stop(); } } catch { /* ignore */ }
  stream?.getTracks().forEach((t) => t.stop());
  if (recording.url) { try { URL.revokeObjectURL(recording.url); } catch { /* ignore */ } }
  mr = null; stream = null; recording.url = null; recording.blob = null; recording.mime = '';
  if (playback.el) { playback.el.pause(); playback.el = null; }
}
