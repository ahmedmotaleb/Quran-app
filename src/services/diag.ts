/** Recording diagnostics (owner request 24 Oct): when recording or sending fails on a phone, a short note goes to the
 *  server log so the cause is visible without screenshots. No audio, no names, no free text. Never blocks the user. */
import { LIVE, api } from '@/api/client';
import { REC_TYPES } from './media';

export type DiagEvent = 'mic_denied' | 'recorder_unsupported' | 'recorder_error' | 'recording_empty' | 'recording_ok'
  | 'upload_failed' | 'submit_failed' | 'submit_ok';

const supported = () => {
  try {
    return typeof MediaRecorder === 'undefined' ? ['no-MediaRecorder']
      : [...REC_TYPES, 'audio/mp4;codecs=mp4a.40.2', 'audio/aac'].filter((t) => MediaRecorder.isTypeSupported(t));
  } catch { return ['check-failed']; }
};
const standalone = () => {
  try { return window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true; }
  catch { return false; }
};

export function diag(event: DiagEvent, extra: { step?: string; error?: unknown; code?: string; status?: number; mime?: string; secs?: number; size?: number } = {}) {
  if (!LIVE) return;
  const e = extra.error as { name?: string; message?: string } | undefined;
  const body = {
    event, step: extra.step, code: extra.code, status: extra.status, mime: extra.mime, secs: extra.secs,
    size_kb: extra.size !== undefined ? Math.round(extra.size / 1024) : undefined,
    error: e ? `${e.name ?? ''}: ${e.message ?? ''}`.slice(0, 160) : undefined,
    supported: supported(), standalone: standalone(), online: navigator.onLine,
  };
  void api('POST', 'client-diagnostics', body).catch(() => { /* diagnostics must never disturb the student */ });
}
