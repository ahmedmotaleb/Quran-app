/** Shared building blocks for the live admin sections. */
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { color } from '@/theme/tokens';
import { FieldError, inputStyle, labelStyle } from '@/components/ui';
import { Icon } from '@/components/Icon';
import type { ApiError } from '@/api/client';
import { card } from '../AdminTables';
import { toast } from '../adminStore';

export const errMsg = (e: unknown) => (e as ApiError)?.message || 'تعذّر تنفيذ الطلب.';
export const date = (iso: string | null) => (iso ? new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeZone: 'Africa/Cairo' }).format(new Date(iso)) : '—');

export const dateTime = (iso: string, tz = 'Africa/Cairo') => new Intl.DateTimeFormat('ar-EG', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(iso));
export const chip = (on: boolean): CSSProperties => ({ minHeight: 40, padding: '0 14px', borderRadius: 999, border: `1px solid ${on ? color.primary : color.borderStrong}`, background: on ? color.primary : color.card, color: on ? color.ivory : color.primary, fontWeight: 700, fontSize: 14, cursor: 'pointer', whiteSpace: 'nowrap' });
export const smallBtn = (tone: 'primary' | 'danger' | 'plain' = 'plain'): CSSProperties => ({
  minHeight: 40, padding: '0 12px', borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: 'pointer',
  border: `1px solid ${tone === 'danger' ? color.danger : tone === 'primary' ? color.primary : color.borderStrong}`,
  background: tone === 'primary' ? color.primary : color.card, color: tone === 'primary' ? color.ivory : tone === 'danger' ? color.danger : color.primary,
});

/* ---------------- Modal shell ---------------- */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('keydown', esc); prev?.focus(); };
  }, [onClose]);
  return (
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, background: 'rgba(20,33,31,.45)', zIndex: 50, display: 'grid', placeItems: 'center', padding: 16 }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} style={{ ...card, background: color.ivory, width: '100%', maxWidth: wide ? 640 : 440, maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto', padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, flex: 1 }}>{title}</h2>
          <button onClick={onClose} aria-label="إغلاق" style={{ width: 44, height: 44, border: 'none', background: 'transparent', cursor: 'pointer', color: color.muted }}><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Asks for a reason, then runs the action; shows the server's error if it fails. */
export function ReasonDialog({ title, body, ok, required = true, onClose, run }: {
  title: string; body: string; ok: string; required?: boolean; onClose: () => void; run: (reason: string) => Promise<void>;
}) {
  const [r, setR] = useState(''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (required && r.trim().length < 3) return setErr('اكتب السبب (3 أحرف على الأقل).');
    setBusy(true); setErr(null);
    try { await run(r.trim()); onClose(); } catch (x) { setErr(errMsg(x)); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form noValidate onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, fontSize: 15 }}>{body}</p>
        <label htmlFor="rs" style={labelStyle}>السبب{required ? '' : ' (اختياري)'}</label>
        <textarea id="rs" rows={3} value={r} onChange={(e) => setR(e.target.value)} maxLength={200} style={{ ...inputStyle(err), minHeight: 88, paddingTop: 10 }} />
        <FieldError msg={err} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" disabled={busy} style={{ ...smallBtn('danger'), minHeight: 48, flex: 1, background: color.danger, color: color.ivory }}>{busy ? 'جارٍ التنفيذ…' : ok}</button>
          <button type="button" onClick={onClose} style={{ ...smallBtn(), minHeight: 48 }}>إلغاء</button>
        </div>
      </form>
    </Modal>
  );
}

export function LinkBox({ link, note }: { link: string; note: string }) {
  const copy = async () => { try { await navigator.clipboard.writeText(link); toast('نُسخ الرابط'); } catch { /* user can select it */ } };
  return (
    <div style={{ background: color.sand, borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ margin: 0, fontSize: 14 }}>{note}</p>
      <code dir="ltr" style={{ fontSize: 12, wordBreak: 'break-all', userSelect: 'all', background: color.card, padding: 8, borderRadius: 8 }}>{link}</code>
      <button onClick={copy} style={{ ...smallBtn('primary'), alignSelf: 'flex-start' }}>نسخ الرابط</button>
    </div>
  );
}

