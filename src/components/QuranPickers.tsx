/** Searchable surah and ayah pickers (mistakes, tasks). The teacher types to filter and must pick a result: free
 *  text is never a value. Surahs are the 114 of the canonical index in Mushaf order; ayahs are 1…count of the chosen
 *  surah only. ARIA combobox + listbox, RTL, rows ≥ 44 px for one-handed use. */
import { useEffect, useId, useRef, useState } from 'react';
import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { inputStyle, labelStyle, muted } from '@/components/ui';
import { searchAyahs, searchSurahs, surahInfo, useSurahIndex } from '@/lib/quranIndex';

interface Opt { value: number; label: string; hint?: string }

function Combobox({ id, label, placeholder, value, display, options, onPick, disabled, invalid, empty }: {
  id: string; label: string; placeholder: string; value: number | null; display: string;
  options: (q: string) => Opt[]; onPick: (v: number) => void; disabled?: boolean; invalid?: boolean; empty: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [up, setUp] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const list = open ? options(q) : [];
  const lb = `${id}-list`;

  useEffect(() => { setActive(0); }, [q, open]);
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (o: Opt) => { onPick(o.value); setOpen(false); setQ(''); input.current?.blur(); };
  const start = () => {
    if (disabled) return;
    setQ(''); setOpen(true);
    // Near the bottom of a phone screen (or above the keyboard) the list opens upwards so the results stay visible.
    const r = input.current?.getBoundingClientRect();
    const h = window.visualViewport?.height ?? window.innerHeight;
    setUp(!!r && h - r.bottom < 260 && r.top > h - r.bottom);
  };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) start(); else setActive((a) => Math.min(a + 1, list.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (open && list[active]) pick(list[active]); }
    else if (e.key === 'Escape') { setOpen(false); setQ(''); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, position: 'relative', minWidth: 0 }}>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      <div style={{ position: 'relative' }}>
        <span aria-hidden style={{ position: 'absolute', insetInlineStart: 12, top: '50%', transform: 'translateY(-50%)', color: color.muted, display: 'flex' }}>
          <Icon name="search" size={18} />
        </span>
        <input ref={input} id={id} role="combobox" aria-expanded={open} aria-controls={lb} aria-autocomplete="list" autoComplete="off"
          aria-activedescendant={open && list[active] ? `${id}-o${list[active].value}` : undefined} aria-invalid={invalid || undefined}
          disabled={disabled} value={open ? q : display} placeholder={open && display ? display : placeholder}
          onFocus={start} onClick={() => { if (!open) start(); }} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onKeyDown={key} onBlur={() => { setOpen(false); setQ(''); }}
          style={{ ...inputStyle(invalid, false, { minHeight: 48, paddingInlineStart: 38, paddingInlineEnd: 34, fontSize: 16 }),
            opacity: disabled ? 0.55 : 1, background: disabled ? color.ivory : color.card }} />
        <span aria-hidden style={{ position: 'absolute', insetInlineEnd: 10, top: '50%', transform: 'translateY(-50%)', color: color.muted, display: 'flex', pointerEvents: 'none' }}>
          <Icon name="chevD" size={18} />
        </span>
      </div>
      {open && (
        <ul ref={listRef} id={lb} role="listbox" aria-label={label}
          style={{ position: 'absolute', ...(up ? { bottom: '100%', margin: '0 0 4px' } : { top: '100%', margin: '4px 0 0' }), insetInline: 0, zIndex: 30, padding: 4, listStyle: 'none', maxHeight: 'min(320px, 45vh)',
            overflowY: 'auto', overscrollBehavior: 'contain', background: color.card, border: `1px solid ${color.borderStrong}`, borderRadius: 12,
            boxShadow: '0 8px 24px rgba(0,0,0,.14)', minWidth: 160 }}>
          {list.length === 0 && <li role="presentation" style={muted(14, { padding: '12px 10px' })}>{empty}</li>}
          {list.map((o, i) => (
            <li key={o.value} id={`${id}-o${o.value}`} data-i={i} role="option" aria-selected={o.value === value}
              onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)} onMouseEnter={() => setActive(i)}
              style={{ minHeight: 44, padding: '6px 10px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                background: i === active ? color.sand : o.value === value ? color.sage : 'transparent', fontWeight: o.value === value ? 800 : 600, fontSize: 15 }}>
              <span style={{ flex: 1 }}>{o.label}</span>
              {o.hint && <span style={{ fontSize: 12, color: color.muted, fontFamily: font.latin }}>{o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** «السورة»: all 114 surahs (search by Arabic name or number). */
export function SurahPicker({ id, value, onChange, invalid, label = 'السورة' }: {
  id?: string; value: number | null; onChange: (n: number) => void; invalid?: boolean; label?: string;
}) {
  const auto = useId();
  const { list, failed, retry } = useSurahIndex();
  const nameOf = (n: number) => list?.[n - 1]?.name || `سورة ${n}`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Combobox id={id ?? `sp${auto}`} label={label} placeholder={list ? 'اكتب اسم السورة…' : 'جارٍ تحميل السور…'} value={value}
        display={value ? `${value}. ${nameOf(value)}` : ''} disabled={!list} invalid={invalid} empty="لا توجد سورة بهذا الاسم."
        options={(q) => searchSurahs(list ?? [], q).map((s) => ({ value: s.n, label: `${s.n}. ${s.name || `سورة ${s.n}`}`, hint: `${s.count} آية` }))}
        onPick={onChange} />
      {failed && <p role="alert" style={{ margin: 0, fontSize: 13, color: color.dangerInk }}>تعذّر تحميل قائمة السور. <button type="button" onClick={retry}
        style={{ border: 0, background: 'none', color: color.primary, fontWeight: 700, textDecoration: 'underline', cursor: 'pointer', padding: 0 }}>إعادة المحاولة</button></p>}
    </div>
  );
}

/** «الآية»: only 1…count of the chosen surah (type the number to jump). Disabled until a surah is chosen. */
export function AyahPicker({ id, surah, value, onChange, invalid, label = 'الآية', hint }: {
  id?: string; surah: number | null; value: number | null; onChange: (n: number) => void; invalid?: boolean; label?: string;
  hint?: (n: number) => string | undefined;
}) {
  const auto = useId();
  useSurahIndex();
  const count = surah ? surahInfo(surah)?.count ?? 0 : 0;
  return (
    <Combobox id={id ?? `ap${auto}`} label={label} placeholder={surah ? 'اكتب رقم الآية…' : 'اختر السورة أولًا'} value={value}
      display={value && count && value <= count ? `الآية ${value}` : ''} disabled={!count} invalid={invalid}
      empty={`لا توجد آية بهذا الرقم؛ السورة ${count} آية.`}
      options={(q) => searchAyahs(count, q).map((n) => ({ value: n, label: `الآية ${n}`, hint: hint?.(n) }))} onPick={onChange} />
  );
}
