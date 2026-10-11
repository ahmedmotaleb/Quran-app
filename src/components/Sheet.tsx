import { useEffect, useRef } from 'react';
import { color, font } from '@/theme/tokens';
import { Icon, type IconName } from './Icon';
import { Spinner, outlineBtn, primaryBtn } from './ui';
import { TZS } from '@/data/demo';
import { normalizeArabic } from '@/lib/format';
import { closeSheet, pickSurah, playAyah, setState, toast, up, useApp } from '@/store/store';

/** Bottom sheet host: confirm / info / ayah actions / surah picker / timezone picker. */
export default function Sheet() {
  const sh = useApp((s) => s.sheet);
  const M = useApp((s) => s.m);
  const tz = useApp((s) => s.tz);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sh) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSheet(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [sh]);

  if (!sh) return null;
  const title = 'title' in sh ? sh.title : sh.kind === 'ayah' ? `الآية ${sh.n}` : sh.kind === 'surahs' ? 'اختر السورة' : 'المنطقة الزمنية';
  const h2 = { margin: '4px 0 0', fontSize: sh.kind === 'confirm' || sh.kind === 'info' ? 19 : 18, fontWeight: 800 } as const;

  let body: React.ReactNode = null;
  if (sh.kind === 'confirm') {
    body = (
      <>
        <p style={{ margin: 0, fontSize: 15, color: color.body, lineHeight: 1.7 }}>{sh.body}</p>
        <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <button onClick={closeSheet} style={outlineBtn(52, 15, { flex: 1 })}>تراجع</button>
          <button onClick={sh.onOk} style={primaryBtn(52, 15, { flex: 1, background: sh.danger ? color.dangerBtn : color.primary, color: color.card })}>{sh.ok}</button>
        </div>
      </>
    );
  } else if (sh.kind === 'info') {
    body = (
      <>
        <p style={{ margin: 0, fontSize: 15, color: color.body, lineHeight: 1.8 }}>{sh.body}</p>
        <button onClick={closeSheet} style={primaryBtn(52, 15)}>حسنًا</button>
      </>
    );
  } else if (sh.kind === 'ayah') {
    const n = sh.n;
    const acts: { label: string; icon: IconName; click: () => void }[] = [
      { label: 'ابدأ النطاق من هذه الآية', icon: 'target', click: () => { closeSheet(); up('m', { from: n, to: Math.max(n, M.to) }); } },
      { label: 'أنهِ النطاق عند هذه الآية', icon: 'target', click: () => { closeSheet(); up('m', { to: n, from: Math.min(n, M.from) }); } },
      { label: M.bookmark === n ? 'إزالة العلامة المرجعية' : 'ضع علامة مرجعية', icon: 'bookmark', click: () => {
        closeSheet(); up('m', { bookmark: M.bookmark === n ? null : n });
        toast(M.bookmark === n ? 'أُزيلت العلامة' : 'حُفظت العلامة عند الآية ' + n, 'bookmark');
      } },
      { label: 'استمع من هذه الآية', icon: 'play', click: () => { closeSheet(); up('m', { from: n, to: Math.max(n, M.to) }); playAyah(n, 0); } },
    ];
    body = acts.map((a) => (
      <button key={a.label} onClick={a.click} style={{ minHeight: 52, padding: '0 14px', borderRadius: 14, border: `1px solid ${color.border}`, background: color.card, color: color.ink, display: 'flex', alignItems: 'center', gap: 10, fontSize: 15, fontWeight: 700, cursor: 'pointer', textAlign: 'right' }}>
        <span style={{ color: color.primary }}><Icon name={a.icon} /></span>{a.label}
      </button>
    ));
  } else if (sh.kind === 'surahs') {
    const q = M.listQ.trim();
    const list = (M.list || []).filter((x) => !q || normalizeArabic(x.name).includes(q));
    body = (
      <>
        <input type="search" aria-label="ابحث عن سورة" placeholder="ابحث باسم السورة" value={M.listQ} onChange={(e) => up('m', { listQ: e.target.value })}
          style={{ width: '100%', minHeight: 48, padding: '0 14px', borderRadius: 12, border: `1.5px solid ${color.borderInput}`, background: color.card, fontSize: 15 }} />
        {M.listErr && <p style={{ margin: 0, fontSize: 12, color: color.warnInk }}>تعذّر تحميل الفهرس الكامل؛ تُعرض السور المتاحة دون اتصال.</p>}
        {!M.list && <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}><Spinner /></div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {list.map((x) => (
            <button key={x.n} onClick={() => pickSurah(x)} aria-current={x.n === M.surah ? 'true' : undefined}
              style={{ minHeight: 52, padding: '0 12px', borderRadius: 12, border: x.n === M.surah ? `1.5px solid ${color.primary}` : 'none', background: color.card, display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', color: color.ink, textAlign: 'right' }}>
              <span style={{ width: 34, height: 34, borderRadius: '50%', border: `1px solid ${color.gold}`, fontFamily: font.latin, fontSize: 12, fontWeight: 700, display: 'grid', placeItems: 'center', color: color.goldInk }}>{x.n}</span>
              <span style={{ flex: 1, fontFamily: font.quran, fontSize: 19 }}>{x.name}</span>
              <span style={{ fontSize: 12, color: color.muted }}>{x.c} آية</span>
            </button>
          ))}
        </div>
      </>
    );
  } else if (sh.kind === 'tz') {
    body = (
      <div role="radiogroup" aria-label="المنطقة الزمنية" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {TZS.map((t) => {
          const on = t.id === tz;
          return (
            <button key={t.id} role="radio" aria-checked={on} onClick={() => { setState({ tz: t.id, sheet: null }); toast('تم تحديث المنطقة الزمنية؛ ستظهر المواعيد بتوقيتك', 'globe'); }}
              style={{ minHeight: 52, padding: '0 14px', borderRadius: 12, border: `1px solid ${color.border}`, background: color.card, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', color: color.ink, fontSize: 15, textAlign: 'right' }}>
              <span style={{ flex: 1 }}>{t.label} ({t.gmt})</span>
              {on && <span style={{ color: color.primary }}><Icon name="check" size={18} /></span>}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 30, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div onClick={closeSheet} style={{ position: 'absolute', inset: 0, background: 'rgba(12,36,33,.45)' }} />
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
        style={{ position: 'relative', background: color.ivory, borderRadius: '24px 24px 0 0', padding: '10px 16px calc(24px + env(safe-area-inset-bottom))', display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '80%', overflowY: 'auto', outline: 'none' }}>
        <span aria-hidden="true" style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 4, background: color.borderStrong }} />
        <h2 style={h2}>{title}</h2>
        {body}
      </div>
    </div>
  );
}
