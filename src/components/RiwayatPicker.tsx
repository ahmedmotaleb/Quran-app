/** «القراءات والروايات»: tick one or more of the 20 primary Riwayat, grouped under the ten Qira'at (from the server's
 *  canonical list). عاصم الكوفي comes first with حفص first (the most common), but nothing is preselected. Groups fold
 *  on a phone; the chosen Riwayat stay visible as chips above them. Used by teachers (their application/account)
 *  and admins (confirm/edit). */
import { useEffect, useState } from 'react';
import { color } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { api } from '@/api/client';

export interface QiraahCat { code: string; name: string; order: number; riwayat: { code: string; name: string; narrator: string; order: number }[] }

let catP: Promise<QiraahCat[]> | null = null;
export function useQiraat() {
  const [c, setC] = useState<QiraahCat[] | null>(null); const [err, setErr] = useState(false);
  useEffect(() => {
    catP ??= api<QiraahCat[]>('GET', 'qiraat').catch((e) => { catP = null; throw e; });
    let on = true; catP.then((x) => on && setC(x)).catch(() => on && setErr(true)); return () => { on = false; };
  }, []);
  return { cat: c, err };
}

/** Display order: عاصم first (حفص before شعبة), then the classical order. */
export function displayOrder(cat: QiraahCat[]): QiraahCat[] {
  const asim = cat.find((q) => q.code === 'asim');
  const rest = cat.filter((q) => q.code !== 'asim');
  return asim ? [{ ...asim, riwayat: [...asim.riwayat].sort((a, b) => (a.code === 'hafs' ? -1 : b.code === 'hafs' ? 1 : a.order - b.order)) }, ...rest] : cat;
}

export function RiwayatChips({ items, pending }: { items: { code: string; name: string }[]; pending?: Set<string> }) {
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {items.map((r) => {
        const wait = pending?.has(r.code);
        return (
          <li key={r.code} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 999, fontSize: 13, fontWeight: 700,
            background: wait ? color.goldTint : color.sage, color: wait ? color.goldInk : color.primary }}>
            {!wait && <Icon name="check" size={14} />}{r.name}{wait && <span style={{ fontWeight: 500 }}> · بانتظار الاعتماد</span>}
          </li>
        );
      })}
    </ul>
  );
}

export function RiwayatPicker({ value, onChange, idPrefix = 'rw', invalid }: {
  value: string[]; onChange: (codes: string[]) => void; idPrefix?: string; invalid?: boolean;
}) {
  const { cat, err } = useQiraat();
  const [open, setOpen] = useState<Set<string> | null>(null);
  useEffect(() => {
    // Initially open: عاصم and every group with a chosen Riwayah.
    if (cat && !open) setOpen(new Set(['asim', ...cat.filter((q) => q.riwayat.some((r) => value.includes(r.code))).map((q) => q.code)]));
  }, [cat, open, value]);
  if (err) return <p role="alert" style={{ margin: 0, color: color.dangerInk, fontSize: 14 }}>تعذّر تحميل قائمة القراءات. أعد المحاولة.</p>;
  if (!cat || !open) return <p role="status" style={{ margin: 0, color: color.muted, fontSize: 14 }}>جارٍ التحميل…</p>;
  const groups = displayOrder(cat);
  const names = new Map(cat.flatMap((q) => q.riwayat.map((r) => [r.code, r.name] as const)));
  const toggle = (code: string) => onChange(value.includes(code) ? value.filter((c) => c !== code) : [...value, code]);
  const fold = (q: string) => setOpen((o) => { const n = new Set(o); if (n.has(q)) n.delete(q); else n.add(q); return n; });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div aria-live="polite" style={{ minHeight: 24 }}>
        {value.length ? <RiwayatChips items={value.map((c) => ({ code: c, name: names.get(c) ?? c }))} />
          : <span style={{ fontSize: 13, color: invalid ? color.dangerInk : color.muted, fontWeight: invalid ? 700 : 400 }}>لم تُختر أي رواية بعد.</span>}
      </div>
      {groups.map((q) => {
        const isOpen = open.has(q.code); const n = q.riwayat.filter((r) => value.includes(r.code)).length;
        const panel = `${idPrefix}-${q.code}`;
        return (
          <section key={q.code} style={{ border: `1px solid ${n ? color.primary : color.border}`, borderRadius: 14, background: color.card, overflow: 'hidden' }}>
            <button type="button" aria-expanded={isOpen} aria-controls={panel} onClick={() => fold(q.code)}
              style={{ width: '100%', minHeight: 48, padding: '0 12px', border: 'none', background: 'transparent', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: color.ink, fontSize: 15, fontWeight: 800, textAlign: 'right' }}>
              <span style={{ display: 'flex', transform: isOpen ? 'none' : 'rotate(90deg)', transition: 'transform .15s', color: color.muted }}><Icon name="chevD" size={18} /></span>
              <span style={{ flex: 1 }}>{q.name}</span>
              {n > 0 && <span style={{ fontSize: 12, fontWeight: 700, color: color.primary }}>{n === 2 ? 'الروايتان' : 'رواية واحدة'}</span>}
            </button>
            {isOpen && (
              <div id={panel} role="group" aria-label={q.name} style={{ display: 'flex', flexDirection: 'column', padding: '0 8px 8px' }}>
                {q.riwayat.map((r) => {
                  const on = value.includes(r.code);
                  return (
                    <label key={r.code} style={{ minHeight: 48, display: 'flex', alignItems: 'center', gap: 12, padding: '0 6px', borderRadius: 10, cursor: 'pointer', background: on ? color.sageTint : 'transparent', fontSize: 15, fontWeight: on ? 700 : 500 }}>
                      <input type="checkbox" checked={on} onChange={() => toggle(r.code)} style={{ width: 22, height: 22, accentColor: color.primary, flexShrink: 0, margin: 0 }} />
                      {r.name}
                    </label>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
