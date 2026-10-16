/**
 * The teacher's optional voice note on feedback (live mode). Its own MediaRecorder, so it never touches the student
 * recorder's state. The note stays on the device until the feedback is sent; then it is uploaded as private
 * "voice_feedback" media and attached to that feedback (only the student and the teacher can play it).
 */
let mr: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
let started = 0;
export const voiceNote: { blob: Blob | null; url: string | null; secs: number } = { blob: null, url: null, secs: 0 };

export const voiceNoteRecording = () => !!mr && mr.state !== 'inactive';

export async function startVoiceNote(): Promise<void> {
  discardVoiceNote();
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream = s; chunks = []; started = Date.now();
  const r = new MediaRecorder(s); mr = r;
  r.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  r.start();
}

/** Stops recording; resolves once the note is ready to play back. */
export function stopVoiceNote(): Promise<void> {
  return new Promise((resolve) => {
    const r = mr;
    if (!r || r.state === 'inactive') { resolve(); return; }
    r.onstop = () => {
      const b = new Blob(chunks, { type: r.mimeType || 'audio/webm' });
      voiceNote.blob = b.size ? b : null;
      voiceNote.url = b.size ? URL.createObjectURL(b) : null;
      voiceNote.secs = Math.max(1, Math.round((Date.now() - started) / 1000));
      stream?.getTracks().forEach((t) => t.stop());
      mr = null; stream = null;
      resolve();
    };
    r.stop();
  });
}

export function discardVoiceNote() {
  try { if (mr && mr.state !== 'inactive') { mr.onstop = null; mr.stop(); } } catch { /* ignore */ }
  stream?.getTracks().forEach((t) => t.stop());
  if (voiceNote.url) URL.revokeObjectURL(voiceNote.url);
  mr = null; stream = null; voiceNote.blob = null; voiceNote.url = null; voiceNote.secs = 0;
}
