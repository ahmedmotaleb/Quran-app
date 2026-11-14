/** The Mushaf's audio panel, compact for phones (owner request, 14 Nov 2026). Layout only: every control calls the
 *  same store actions as before (play/pause/resume/stop, ×1/×3/×5/×10/∞, speed, reciter, range loop, continue after
 *  the range), and keeps the same accessible names.
 *  - Expanded, about 210 px at 360 px wide (was about 350): a one-line status with a collapse button; play, stop and
 *    repetition in one row; speed (segmented) and reciter in one row; the two range options side by side.
 *  - Collapsed (mini player, about 64 px): play/pause, the reciter, and the repetition (tap to cycle). Tapping the
 *    reciter expands the panel. The choice is remembered on this device.
 *  - Every control is at least 44×44 CSS px, RTL, no sideways scrolling at 360 px, Android safe area respected. */
import { useState, type CSSProperties } from 'react';
import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import type { AyahAudioCfg } from '@/api/endpoints';
import { pauseMushaf, playAyah, resumeMushaf, setMushafRate, setReciter, stopMushaf, up, useApp } from '@/store/store';
import { repLabel } from '@/lib/recitation';

const REPEATS = [1, 3, 5, 10, 0] as const;
const RATES = [0.75, 1, 1.25] as const;
const KEY = 'halqa.mushaf.player.mini';
const readMini = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const saveMini = (v: boolean) => { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* private mode */ } };

const group: CSSProperties = { display: 'flex', alignItems: 'center', gap: 0, border: `1px solid ${color.borderChip}`, borderRadius: 12, padding: 1 };
const seg = (on: boolean): CSSProperties => ({
  minWidth: 44, minHeight: 44, padding: '0 4px', border: 'none', borderRadius: 10, background: on ? color.primary : 'transparent',
  color: on ? color.ivory : color.primary, fontFamily: font.latin, fontWeight: 700, fontSize: 14, cursor: 'pointer', flexShrink: 0,
});
const iconBtn: CSSProperties = { width: 44, height: 44, border: 'none', background: 'transparent', color: color.primary, display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0 };
const toggle: CSSProperties = { flex: '1 1 150px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, minHeight: 44, fontSize: 12.5, fontWeight: 700, color: color.ink, cursor: 'pointer' };

export function MushafPlayer({ audioName, pubAudio, reciter, playL }: {
  audioName: string | null; pubAudio: AyahAudioCfg | null; reciter: { id: number; name: string } | null; playL: string;
}) {
  const M = useApp((s) => s.m);
  const setM = (o: Partial<typeof M>) => up('m', o);
  const [mini, setMiniState] = useState(readMini);
  const setMini = (v: boolean) => { setMiniState(v); saveMini(v); };
  const ready = !!M.data && !!audioName;
  const reciters = pubAudio?.reciters ?? [];

  const play = (size: number) => (
    // Play → pause → resume (the ayah, the place in it and the repetition count are kept); stop ends it.
    <button onClick={() => (!M.playing ? playAyah(M.from, 0) : M.paused ? resumeMushaf() : pauseMushaf())} aria-label={playL} disabled={!ready}
      style={{ width: size, height: size, borderRadius: '50%', border: 'none', background: color.primary, color: color.ivory, display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0, opacity: ready ? 1 : 0.6 }}>
      <Icon name={M.playing && !M.paused ? 'pause' : 'play'} />
    </button>
  );
  const state = M.playing ? (M.paused ? 'متوقفة مؤقتًا' : 'جارٍ التشغيل') : playL;
  const detail = M.playing ? `الآية ${M.cur} · ${repLabel(M.rep, M.repeat)}${M.cur && M.cur > M.to ? ' · متابعة بعد النطاق' : ''}`
    : audioName ? `النطاق ${M.from}–${M.to} · ${audioName}` : 'التلاوة الصوتية غير متاحة حاليًا';

  const shell: CSSProperties = {
    position: 'sticky', bottom: 0, zIndex: 4, background: color.card, borderTop: `1px solid ${color.border}`,
    padding: '4px 12px', paddingBottom: 'calc(6px + env(safe-area-inset-bottom))', display: 'flex', flexDirection: 'column', gap: 6,
  };

  if (mini) {
    const next = REPEATS[(REPEATS.indexOf(M.repeat as (typeof REPEATS)[number]) + 1) % REPEATS.length];
    return (
      <section aria-label="مشغل التلاوة (مصغّر)" data-testid="mushaf-player" data-mini="true" style={{ ...shell, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {play(44)}
        <button onClick={() => setMini(false)} aria-label="توسيع مشغل التلاوة" aria-expanded={false}
          style={{ flex: 1, minWidth: 0, minHeight: 44, border: 'none', background: 'transparent', textAlign: 'right', cursor: 'pointer', color: color.ink, padding: 0 }}>
          <span style={{ display: 'block', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{reciter?.name ?? audioName ?? 'التلاوة'}</span>
          <span aria-live="polite" data-testid="recital-status" style={{ display: 'block', fontSize: 11.5, color: color.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{detail}</span>
        </button>
        <button onClick={() => setM({ repeat: next })} aria-label={`التكرار: ${M.repeat ? `${M.repeat} مرات` : 'باستمرار'} (اضغط للتغيير)`}
          style={{ ...seg(true), display: 'flex', alignItems: 'center', gap: 2 }}>
          <Icon name="repeat" size={14} />{M.repeat ? `×${M.repeat}` : '∞'}
        </button>
        <button onClick={() => setMini(false)} aria-label="توسيع مشغل التلاوة" style={{ ...iconBtn, transform: 'rotate(180deg)' }}><Icon name="chevD" size={20} /></button>
      </section>
    );
  }

  return (
    <section aria-label="مشغل التلاوة" data-testid="mushaf-player" data-mini="false" style={shell}>
      {/* status · collapse */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 32 }}>
        <p style={{ flex: 1, minWidth: 0, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 13 }}>
          <strong>{state}</strong>
          <span aria-live="polite" data-testid="recital-status" style={{ color: color.muted, fontSize: 12 }}> · {detail}</span>
        </p>
        <button onClick={() => setMini(true)} aria-label="تصغير مشغل التلاوة" aria-expanded style={{ ...iconBtn, height: 44, margin: '-6px -8px -6px 0' }}><Icon name="chevD" size={20} /></button>
      </div>
      {/* play · stop · repetition (wraps only below ~330 px) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', rowGap: 6 }}>
        {play(48)}
        {M.playing && (
          <button onClick={stopMushaf} aria-label="إيقاف التلاوة"
            style={{ width: 44, height: 44, borderRadius: '50%', border: `1px solid ${color.borderChip}`, background: color.card, color: color.primary, display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0 }}>
            <Icon name="x" size={18} />
          </button>
        )}
        <div role="group" aria-label="تكرار كل آية" style={{ ...group, marginInlineStart: 'auto', minWidth: 0 }}>
          {REPEATS.map((n) => (
            <button key={n} aria-pressed={M.repeat === n} aria-label={n ? `تكرار كل آية ${n} مرات` : 'تكرار الآية باستمرار'} onClick={() => setM({ repeat: n })}
              style={seg(M.repeat === n)}>{n ? `×${n}` : '∞'}</button>
          ))}
        </div>
      </div>
      {audioName && (<>
        {/* speed (segmented) · reciter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div role="group" aria-label="سرعة التلاوة" title="السرعة" style={{ ...group, flexShrink: 0 }}>
            {RATES.map((r) => (
              <button key={r} aria-pressed={M.rate === r} aria-label={`السرعة ${r}`} onClick={() => setMushafRate(r)} style={seg(M.rate === r)}>{r}×</button>
            ))}
          </div>
          {reciters.length > 1 && (
            <select aria-label="القارئ" value={reciter?.id ?? ''} onChange={(e) => setReciter(Number(e.target.value))}
              style={{ flex: 1, minWidth: 0, minHeight: 44, borderRadius: 10, border: `1px solid ${color.borderChip}`, background: color.card, color: color.primary, fontWeight: 700, fontSize: 13, padding: '0 6px', textOverflow: 'ellipsis' }}>
              {reciters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
        </div>
        {/* range options, side by side */}
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
      </>)}
    </section>
  );
}
