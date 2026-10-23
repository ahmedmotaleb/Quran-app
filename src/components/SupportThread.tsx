/** Shared pieces of the support-ticket UI (PROMPT 49): the message thread, a screenshot picker and an attached image.
 *  Used by the learners' app («الدعم») and the admin portal («طلبات الدعم»). */
import { useEffect, useRef, useState } from 'react';
import { color } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { IMAGE_TYPES, MAX_IMAGE_BYTES, mediaUrl, type TicketMsg } from '@/api/support';

const when = (iso: string) => new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Cairo' }).format(new Date(iso));

/** A private screenshot: fetched through a short-lived signed URL, only when shown. */
export function AttachedImage({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null); const [err, setErr] = useState(false);
  useEffect(() => { mediaUrl(id).then((m) => setUrl(m.url)).catch(() => setErr(true)); }, [id]);
  if (err) return <span style={{ fontSize: 13, color: color.muted }}>تعذّر عرض الصورة.</span>;
  if (!url) return <span role="status" style={{ fontSize: 13, color: color.muted }}>جارٍ تحميل الصورة…</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" aria-label="فتح الصورة المرفقة" style={{ display: 'inline-block', maxWidth: '100%' }}>
      <img src={url} alt="صورة مرفقة" style={{ display: 'block', maxWidth: 'min(100%, 260px)', maxHeight: 220, borderRadius: 10, border: `1px solid ${color.border}` }} />
    </a>
  );
}

/** Pick one screenshot (PNG/JPEG/WebP, up to 5 MB). Checked here for a quick answer; the server checks again. */
export function ImagePicker({ file, onChange, id }: { file: File | null; onChange: (f: File | null, err?: string) => void; id: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!IMAGE_TYPES.split(',').includes(f.type)) return onChange(null, 'أرفق صورة فقط (PNG أو JPEG أو WebP).');
    if (f.size > MAX_IMAGE_BYTES) return onChange(null, 'حجم الصورة أكبر من 5 ميغابايت.');
    onChange(f);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <input ref={ref} id={id} type="file" accept={IMAGE_TYPES} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }}
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }} aria-label="إرفاق لقطة شاشة" />
      <button type="button" onClick={() => ref.current?.click()}
        style={{ minHeight: 44, padding: '0 12px', borderRadius: 12, border: `1px dashed ${color.borderStrong}`, background: 'transparent', color: color.primary, fontWeight: 700, fontSize: 14, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Icon name="upload" size={18} />{file ? 'تغيير الصورة' : 'إرفاق لقطة شاشة (اختياري)'}
      </button>
      {file && <span style={{ fontSize: 13, color: color.body, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {file.name}
        <button type="button" onClick={() => onChange(null)} aria-label="إزالة الصورة" style={{ width: 36, height: 36, border: 'none', background: 'transparent', color: color.muted, cursor: 'pointer' }}><Icon name="x" size={16} /></button>
      </span>}
    </div>
  );
}

/** The conversation. Staff see internal notes (marked); the requester never receives them from the server. */
export function Thread({ messages, staff = false }: { messages: TicketMsg[]; staff?: boolean }) {
  return (
    <ol aria-label="المحادثة" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {messages.map((m) => {
        const mine = staff ? m.from_staff : !m.from_staff;
        const who = m.internal ? `ملاحظة داخلية · ${m.author?.name ?? ''}` : m.from_staff ? (staff ? `${m.author?.name ?? 'فريق الدعم'} · فريق الدعم` : 'فريق الدعم') : (m.author?.name ?? 'أنت');
        return (
          <li key={m.id} style={{ alignSelf: mine ? 'flex-start' : 'flex-end', maxWidth: '88%', display: 'flex', flexDirection: 'column', gap: 6,
            padding: '10px 12px', borderRadius: 14, background: m.internal ? '#FFF6E0' : mine ? color.card : color.sage,
            border: `1px ${m.internal ? 'dashed' : 'solid'} ${m.internal ? color.gold : color.border}` }}>
            <span style={{ fontSize: 12, color: color.muted, fontWeight: 700 }}>{who} · {when(m.created_at)}</span>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.7, whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{m.body}</p>
            {m.attachment && <AttachedImage id={m.attachment.id} />}
          </li>
        );
      })}
    </ol>
  );
}
