/** Shared building blocks for the live admin sections. */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { color, font } from '@/theme/tokens';
import { FieldError, inputStyle, labelStyle } from '@/components/ui';
import { Icon } from '@/components/Icon';
import type { ApiError, Page } from '@/api/client';
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


export const PAGE = 20;
/** Server-paged list with a stale-response guard. */
export function usePaged<T>(fetcher: (page: number) => Promise<Page<T>>, deps: unknown[]) {
  const [page, setPage] = useState(1); const [data, setData] = useState<Page<T> | null>(null);
  const [err, setErr] = useState<string | null>(null); const [loading, setLoading] = useState(true); const seq = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(async () => {
    const my = ++seq.current; setLoading(true); setErr(null);
    try { const d = await fetcher(page); if (my === seq.current) setData(d); } catch (e) { if (my === seq.current) setErr(errMsg(e)); }
    finally { if (my === seq.current) setLoading(false); }
  }, [page, ...deps]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setPage(1); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { page, setPage, data, err, loading, reload: load };
}

export function Table({ cols, children, loading, err, empty, retry }: { cols: string[]; children: ReactNode; loading: boolean; err: string | null; empty: boolean; retry: () => void }) {
  return (
    <div style={{ ...card, overflowX: 'auto' }} aria-busy={loading}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, minWidth: 760 }}>
        <thead><tr style={{ background: color.sand, textAlign: 'right' }}>{cols.map((c) => <th key={c} scope="col" style={{ padding: '12px 16px', fontWeight: 700, color: color.body, whiteSpace: 'nowrap' }}>{c}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
      {loading && empty && !err && <p role="status" style={{ margin: 0, padding: 28, textAlign: 'center', color: color.muted }}>جارٍ التحميل…</p>}
      {err && <div role="alert" style={{ padding: 20, display: 'flex', gap: 12, justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' }}><span style={{ color: color.danger }}>{err}</span><button onClick={retry} style={smallBtn('primary')}>إعادة المحاولة</button></div>}
      {!loading && !err && empty && <p style={{ margin: 0, padding: 28, textAlign: 'center', color: color.muted }}>لا توجد نتائج مطابقة.</p>}
    </div>
  );
}

export function Pager({ page, total, setPage }: { page: number; total: number; setPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  if (!total) return null;
  return (
    <nav aria-label="الصفحات" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <p style={{ margin: 0, fontSize: 14, color: color.muted }}>عرض {(page - 1) * PAGE + 1}–{Math.min(page * PAGE, total)} من {total}</p>
      {pages > 1 && <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button disabled={page === 1} onClick={() => setPage(page - 1)} aria-label="الصفحة السابقة" style={smallBtn()}><Icon name="chevR" size={18} /></button>
        <span style={{ fontFamily: font.latin, minWidth: 64, textAlign: 'center' }}>{page} / {pages}</span>
        <button disabled={page === pages} onClick={() => setPage(page + 1)} aria-label="الصفحة التالية" style={smallBtn()}><Icon name="chevL" size={18} /></button>
      </div>}
    </nav>
  );
}

export function SearchBar({ q, setQ, label, action }: { q: string; setQ: (v: string) => void; label: string; action?: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
      <input type="search" aria-label={label} placeholder={label} value={q} onChange={(e) => setQ(e.target.value)}
        style={{ flex: '1 1 240px', minHeight: 48, padding: '0 14px', borderRadius: 12, border: `1.5px solid ${color.borderInput}`, background: color.card, fontSize: 15 }} />
      {action}
    </div>
  );
}
export function useDebounced(v: string) { const [d, setD] = useState(v); useEffect(() => { const t = setTimeout(() => setD(v.trim()), 300); return () => clearTimeout(t); }, [v]); return d; }

