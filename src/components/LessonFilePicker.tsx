/** Pick and upload a lesson file (PDF or audio) for admins and teachers. The upload happens on selection, so the
 *  form only saves a server-validated file id; the type must match the lesson kind. */
import { useState } from 'react';
import { color } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { FieldError } from '@/components/ui';
import { LESSON_FILE_ACCEPT, uploadLessonFile } from '@/api/endpoints';
import type { ApiError } from '@/api/client';

export function LessonFilePicker({ id, kind, current, err, onUploaded }: {
  id: string; kind: 'audio' | 'pdf'; current?: string | null; err?: string | null; onUploaded: (mediaId: string | null) => void;
}) {
  const [name, setName] = useState<string | null>(current ?? null);
  const [busy, setBusy] = useState(false);
  const [upErr, setUpErr] = useState<string | null>(null);
  const accept = kind === 'pdf' ? 'application/pdf' : LESSON_FILE_ACCEPT.split(',').filter((t) => t.startsWith('audio/')).join(',');
  const pick = async (f: File | undefined) => {
    if (!f) return;
    if ((kind === 'pdf') !== (f.type === 'application/pdf')) { setUpErr(kind === 'pdf' ? 'اختر ملف PDF.' : 'اختر ملفًا صوتيًا.'); return; }
    setBusy(true); setUpErr(null); onUploaded(null);
    try { const m = await uploadLessonFile(f); setName(f.name); onUploaded(m.id); }
    catch (e) { const a = e as ApiError; setName(null); setUpErr(a.field?.('file') ?? a.message); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label htmlFor={id} style={{ minHeight: 64, borderRadius: 14, border: `1.5px dashed ${color.borderStrong}`, background: color.card, color: color.primary, fontSize: 15, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer', padding: '0 12px' }}>
        <Icon name={name ? 'file' : 'upload'} />
        <span dir="auto">{busy ? 'جارٍ الرفع…' : name ? `رُفع: ${name} — اضغط للاستبدال` : kind === 'pdf' ? 'اختر ملف PDF' : 'اختر ملفًا صوتيًا (MP3 أو M4A…)'}</span>
      </label>
      <input id={id} type="file" accept={accept} onChange={(e) => pick(e.target.files?.[0])} style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }} aria-label={kind === 'pdf' ? 'ملف PDF للدرس' : 'ملف صوتي للدرس'} />
      <FieldError msg={upErr ?? err} fs={12} />
    </div>
  );
}
