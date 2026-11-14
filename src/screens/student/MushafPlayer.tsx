/** The Mushaf's audio player: a mini player that is always visible, plus the settings as a bottom sheet
 *  (owner requests, 14 Nov 2026).
 *
 *  UI state only. `open` (whether the settings sheet is shown) lives in this component. The recitation (one module-level
 *  <audio> in store.ts, never in the React tree) and its state (`m.playing`, `cur`, `rep`, …) are untouched by
 *  opening or closing the sheet, so collapsing or expanding never restarts, reloads or resets anything.
 *
 *  - Mini player: about 56–60 px plus the Android safe area. It sits in the page flow (sticky at the bottom), so it
 *    never covers Quran text. It shows a thin progress line across the range, play/pause, the reciter, the surah ·
 *    ayah and repetition status, stop (while playing), and the expand arrow.
 *  - Pressing Play (or Resume) closes the sheet. Moving to the next ayah, pausing or stopping never reopens it.
 *  - Settings sheet: slides up above the mini player (250 ms) with the ayah repetition, speed, reciter, range repeat
 *    («إعادة النطاق من البداية»), continue after the range, and restart from the start of the range. Closed with
 *    the collapse button or a downward swipe on its handle. The Mushaf behind it stays scrollable.
 *  - Every control is at least 44×44 CSS px, RTL, and fits a 360 px screen. */
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import type { AyahAudioCfg } from '@/api/endpoints';
import { mushafAudio } from '@/services/media';
import { pauseMushaf, playAyah, resumeMushaf, setMushafRate, setReciter, stopMushaf, up, useApp } from '@/store/store';
import { repLabel } from '@/lib/recitation';

const REPEATS = [1, 3, 5, 10, 0] as const;
const RATES = [0.75, 1, 1.25] as const;
const MS = 250;

const group: CSSProperties = { display: 'flex', alignItems: 'center', border: `1px solid ${color.borderChip}`, borderRadius: 12, padding: 1 };
const seg = (on: boolean): CSSProperties => ({
  minWidth: 44, minHeight: 44, padding: '0 4px', border: 'none', borderRadius: 10, background: on ? color.primary : 'transparent',
  color: on ? color.ivory : color.primary, fontFamily: font.latin, fontWeight: 700, fontSize: 14, cursor: 'pointer', flexShrink: 0,
});
const iconBtn: CSSProperties = { width: 44, height: 44, border: 'none', background: 'transparent', color: color.primary, display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0 };
const toggle: CSSProperties = { flex: '1 1 150px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, minHeight: 44, fontSize: 12.5, fontWeight: 700, color: color.ink, cursor: 'pointer' };
const label: CSSProperties = { fontSize: 12, fontWeight: 700, color: color.muted, margin: 0 };

/** Where the recitation is inside the selected range, 0…1 (the current ayah's own progress included). */
function useRangeProgress(): number {
  const M = useApp((s) => s.m);
  const [frac, setFrac] = useState(0);
  useEffect(() => {
    if (!M.playing) { setFrac(0); return; }
    // 4 times a second (smoothed by a matching CSS transition): cheap on phones, no re-render every frame.
    const tick = () => {
      const el = mushafAudio.el;
      setFrac(el && el.duration > 0 && Number.isFinite(el.duration) ? Math.min(1, el.currentTime / el.duration) : 0);
    };
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [M.playing, M.cur]);
  if (!M.playing || M.cur == null) return 0;
  const span = Math.max(1, M.to - M.from + 1);
  return Math.min(1, Math.max(0, (Math.min(M.cur, M.to) - M.from + (M.cur > M.to ? 1 : frac)) / span));
}

export function MushafPlayer({ audioName, pubAudio, reciter, playL, surahName }: {
  audioName: string | null; pubAudio: AyahAudioCfg | null; reciter: { id: number; name: string } | null; playL: string; surahName: string;
}) {
  const M = useApp((s) => s.m);
  const setM = (o: Partial<typeof M>) => up('m', o);
  const [open, setOpen] = useState(false);          // player UI state only (never the recitation's)
  const [drag, setDrag] = useState(0);              // px the sheet is being pulled down
  const startY = useRef<number | null>(null);
  const sheet = useRef<HTMLElement>(null);
  // A closed sheet cannot take focus or taps (keyboard and screen readers skip it).
  useEffect(() => { if (sheet.current) sheet.current.inert = !open; }, [open]);
  const ready = !!M.data && !!audioName;
  const reciters = pubAudio?.reciters ?? [];
  const progress = useRangeProgress();
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const onPlay = () => {
    if (!M.playing) playAyah(M.from, 0); else if (M.paused) resumeMushaf(); else { pauseMushaf(); return; }
    setOpen(false);                                 // Play / Resume: settings out of the way, the Mushaf in view
  };
  const restartRange = () => { playAyah(M.from, 0); setOpen(false); };

  // Swipe down on the sheet's handle to close it.
  const down = (e: RPointerEvent) => { startY.current = e.clientY; (e.target as Element).setPointerCapture?.(e.pointerId); };
  const move = (e: RPointerEvent) => { if (startY.current != null) setDrag(Math.max(0, e.clientY - startY.current)); };
  const upPtr = () => { if (startY.current == null) return; if (drag > 50) setOpen(false); startY.current = null; setDrag(0); };

  const detail = M.playing ? `الآية ${M.cur} · ${repLabel(M.rep, M.repeat)}${M.cur && M.cur > M.to ? ' · متابعة بعد النطاق' : ''}`
    : audioName ? `النطاق ${M.from}–${M.to}` : 'التلاوة الصوتية غير متاحة حاليًا';
  const who = reciter?.name ?? audioName ?? 'التلاوة';

  return (
    <div data-testid="mushaf-player" data-open={open ? 'true' : 'false'} style={{ position: 'sticky', bottom: 0, zIndex: 4 }}>
      {/* ---- settings: bottom sheet above the mini player. The wrapper clips the closed sheet (no extra scroll height)
           and lets taps through to the Mushaf; only the open sheet takes them. ---- */}
      <div style={{ position: 'absolute', insetInline: 0, bottom: '100%', zIndex: 1, overflow: 'hidden', pointerEvents: 'none', paddingTop: 16 }}>
      <section id="mushaf-player-settings" aria-label="إعدادات التلاوة" ref={sheet} aria-hidden={!open}
        style={{
          pointerEvents: open ? 'auto' : 'none', background: color.card, borderTop: `1px solid ${color.border}`,
          borderRadius: '18px 18px 0 0', boxShadow: '0 -8px 24px -12px rgba(0,0,0,.25)', padding: '0 12px 10px',
          display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '70dvh', overflowY: 'auto',
          transform: open ? `translateY(${drag}px)` : 'translateY(calc(100% + 24px))', visibility: open ? 'visible' : 'hidden',
          transition: drag ? 'none' : reduced ? 'none' : `transform ${MS}ms ease, visibility ${MS}ms`,
        }}>
        <div onPointerDown={down} onPointerMove={move} onPointerUp={upPtr} onPointerCancel={upPtr}
          style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 44, touchAction: 'none', cursor: 'grab', position: 'relative' }}>
          <span aria-hidden style={{ position: 'absolute', top: 6, insetInlineStart: '50%', transform: 'translateX(50%)', width: 36, height: 4, borderRadius: 2, background: color.borderStrong }} />
          <p style={{ flex: 1, margin: '8px 0 0', fontSize: 14, fontWeight: 800, color: color.ink }}>إعدادات التلاوة</p>
          <button onClick={() => setOpen(false)} aria-label="تصغير مشغل التلاوة" style={{ ...iconBtn, marginInlineEnd: -8 }}><Icon name="chevD" size={20} /></button>
        </div>
        <p style={label}>تكرار كل آية</p>
        <div role="group" aria-label="تكرار كل آية" style={{ ...group, justifyContent: 'space-between' }}>
          {REPEATS.map((n) => (
            <button key={n} aria-pressed={M.repeat === n} aria-label={n ? `تكرار كل آية ${n} مرات` : 'تكرار الآية باستمرار'} onClick={() => setM({ repeat: n })}
              style={{ ...seg(M.repeat === n), flex: 1 }}>{n ? `×${n}` : '∞'}</button>
          ))}
        </div>
        {audioName && (<>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div role="group" aria-label="سرعة التلاوة" title="السرعة" style={{ ...group, flexShrink: 0 }}>
              {RATES.map((r) => (
                <button key={r} aria-pressed={M.rate === r} aria-label={`السرعة ${r}`} onClick={() => setMushafRate(r)} style={seg(M.rate === r)}>{r}×</button>
              ))}
            </div>
            {reciters.length > 1 && (
              <select aria-label="القارئ" value={reciter?.id ?? ''} onChange={(e) => setReciter(Number(e.target.value))}
                style={{ flex: 1, minWidth: 0, minHeight: 44, borderRadius: 10, border: `1px solid ${color.borderChip}`, background: color.card, color: color.primary, fontWeight: 700, fontSize: 13, padding: '0 6px' }}>
                {reciters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label style={toggle}>
              <input type="checkbox" checked={!!M.loop} onChange={(e) => setM({ loop: e.target.checked })} style={{ width: 18, height: 18, margin: 0, flexShrink: 0, accentColor: color.primary }} />
              إعادة النطاق من البداية
            </label>
            <label style={{ ...toggle, opacity: M.loop ? 0.5 : 1 }}>
              <input type="checkbox" checked={M.adv} disabled={!!M.loop} onChange={(e) => setM({ adv: e.target.checked })} style={{ width: 18, height: 18, margin: 0, flexShrink: 0, accentColor: color.primary }} />
              متابعة بعد نهاية النطاق
            </label>
          </div>
          <button onClick={restartRange} disabled={!ready}
            style={{ minHeight: 44, borderRadius: 12, border: `1px solid ${color.borderChip}`, background: color.card, color: color.primary, fontWeight: 700, fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: ready ? 1 : 0.6 }}>
            <Icon name="refresh" size={16} /> تشغيل من بداية النطاق ({M.from})
          </button>
        </>)}
      </section>
      </div>

      {/* ---- mini player: always visible, in the page flow (never covers the Quran text) ---- */}
      <section aria-label="مشغل التلاوة" style={{ position: 'relative', zIndex: 2, background: color.card, borderTop: `1px solid ${color.border}`,
        padding: '6px 10px', paddingBottom: 'calc(6px + env(safe-area-inset-bottom))', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div role="progressbar" aria-label="تقدّم التلاوة في النطاق" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}
          style={{ position: 'absolute', top: -1, insetInline: 0, height: 3, background: 'transparent' }}>
          <div data-testid="player-progress" style={{ height: '100%', width: `${progress * 100}%`, background: color.primary, marginInlineStart: 0, transition: 'width 250ms linear' }} />
        </div>
        {/* Play → pause → resume (the ayah, the place in it and the repetition count are kept). */}
        <button onClick={onPlay} aria-label={playL} disabled={!ready}
          style={{ width: 44, height: 44, borderRadius: '50%', border: 'none', background: color.primary, color: color.ivory, display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0, opacity: ready ? 1 : 0.6 }}>
          <Icon name={M.playing && !M.paused ? 'pause' : 'play'} />
        </button>
        <button onClick={() => setOpen(!open)} aria-label={`${who} · ${surahName}`} aria-controls="mushaf-player-settings" aria-expanded={open}
          style={{ flex: 1, minWidth: 0, minHeight: 44, border: 'none', background: 'transparent', textAlign: 'right', cursor: 'pointer', color: color.ink, padding: 0 }}>
          <span style={{ display: 'block', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{who}</span>
          <span style={{ display: 'block', fontSize: 11.5, color: color.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {surahName} · <span aria-live="polite" data-testid="recital-status">{M.playing && M.paused ? 'متوقفة مؤقتًا · ' : ''}{detail}</span>
          </span>
        </button>
        {M.playing && (
          <button onClick={stopMushaf} aria-label="إيقاف التلاوة" style={{ ...iconBtn, borderRadius: '50%', border: `1px solid ${color.borderChip}` }}>
            <Icon name="x" size={18} />
          </button>
        )}
        <button onClick={() => setOpen(!open)} aria-label={open ? 'تصغير إعدادات التلاوة' : 'توسيع مشغل التلاوة'} aria-controls="mushaf-player-settings" aria-expanded={open}
          style={{ ...iconBtn, transform: open ? 'none' : 'rotate(180deg)', transition: `transform ${MS}ms` }}>
          <Icon name="chevD" size={20} />
        </button>
      </section>
    </div>
  );
}
