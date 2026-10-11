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
let mr: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
/** Object URL of the last finished recording (null for demo recordings). */
export const recording: { url: string | null; blob: Blob | null } = { url: null, blob: null };

export function recorderSupported() {
  return typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof window.MediaRecorder !== 'undefined';
}

/** Requests the microphone and starts recording. Rejects when permission is denied or unsupported. */
export async function startRecorder(onStop: () => void) {
  discardRecorder();
  if (!recorderSupported()) throw new Error('unsupported');
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream = s; chunks = [];
  const r = new MediaRecorder(s); mr = r;
  r.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  r.onstop = () => {
    const b = new Blob(chunks, { type: r.mimeType || 'audio/webm' });
    recording.url = b.size ? URL.createObjectURL(b) : null;
    recording.blob = b.size ? b : null;
    s.getTracks().forEach((t) => t.stop());
    onStop();
  };
  r.start();
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
  mr = null; stream = null; recording.url = null; recording.blob = null;
  if (playback.el) { playback.el.pause(); playback.el = null; }
}
