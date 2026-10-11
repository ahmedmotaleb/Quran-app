import type { CSSProperties, ReactNode, MouseEvent } from 'react';
import { color, font } from '@/theme/tokens';
import { Icon, type IconName } from './Icon';
import { badge as badgeSpec, fmt, type BadgeSpec } from '@/lib/format';
import type { BadgeKind, TimedNote } from '@/data/types';
import { back as navBack, playerSeek, playerToggle, useApp } from '@/store/store';

/* ---------------- Style factories ---------------- */
export const card: CSSProperties = { background: color.card, border: `1px solid ${color.border}`, borderRadius: 16 };
export const btnReset: CSSProperties = { cursor: 'pointer', fontFamily: 'inherit' };

export const primaryBtn = (h = 54, fs = 17, extra: CSSProperties = {}): CSSProperties => ({
  minHeight: h, border: 'none', borderRadius: 14, background: color.primary, color: color.ivory, fontSize: fs, fontWeight: 700,
  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, ...extra,
});
export const outlineBtn = (h = 52, fs = 15, extra: CSSProperties = {}): CSSProperties => ({
  minHeight: h, borderRadius: 14, border: `1.5px solid ${color.borderStrong}`, background: 'transparent', color: color.primary,
  fontSize: fs, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, ...extra,
});
export const sageBtn = (h = 52, fs = 16, extra: CSSProperties = {}): CSSProperties => ({
  minHeight: h, border: 'none', borderRadius: 14, background: color.sage, color: color.primary, fontSize: fs, fontWeight: 700,
  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, ...extra,
});
export const dangerOutlineBtn = (h = 52, fs = 15, extra: CSSProperties = {}): CSSProperties => ({
  minHeight: h, borderRadius: 14, border: `1.5px solid ${color.dangerBorder}`, background: 'transparent', color: color.dangerInk,
  fontSize: fs, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, ...extra,
});
export const linkBtn = (fs = 15, extra: CSSProperties = {}): CSSProperties => ({
  minHeight: 44, border: 'none', background: 'transparent', color: color.primary, fontSize: fs, fontWeight: 700, cursor: 'pointer', ...extra,
});
export const inputStyle = (error?: unknown, latin = false, extra: CSSProperties = {}): CSSProperties => ({
  width: '100%', minHeight: 52, padding: '0 14px', borderRadius: 12, border: `1.5px solid ${error ? color.danger : color.borderInput}`,
  background: color.card, fontSize: 16, color: color.ink, ...(latin ? { fontFamily: font.latin, textAlign: 'left' } : {}), ...extra,
});
export const labelStyle: CSSProperties = { fontSize: 14, fontWeight: 700 };
export const listBtn: CSSProperties = {
  ...card, padding: 14, display: 'flex', gap: 12, textAlign: 'right', cursor: 'pointer', color: color.ink, alignItems: 'center', width: '100%',
};
export const iconTile = (size: number, bg: string, fg: string = color.primary, r = 14): CSSProperties => ({
  width: size, height: size, borderRadius: r, background: bg, color: fg, display: 'grid', placeItems: 'center', flexShrink: 0,
});
export const H1: CSSProperties = { margin: '12px 0 0', fontSize: 24, fontWeight: 800 };
export const pageCol = (gap = 16, extra: CSSProperties = {}): CSSProperties => ({ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap, ...extra });
export const muted = (fs = 13, extra: CSSProperties = {}): CSSProperties => ({ margin: 0, fontSize: fs, color: color.muted, ...extra });

/* ---------------- Small atoms ---------------- */
export function Spinner({ light = false }: { light?: boolean }) {
  return (
    <span role={light ? undefined : 'img'} aria-label={light ? undefined : 'جارٍ التحميل'} style={{
      width: 26, height: 26, borderRadius: '50%', display: 'inline-block', animation: 'hqspin .9s linear infinite',
      border: light ? '3px solid rgba(247,243,232,.25)' : `3px solid ${color.sage}`, borderTopColor: light ? color.ivory : color.primary,
    }} />
  );
}
export const RecDot = () => (
  <span style={{ width: 10, height: 10, borderRadius: '50%', background: color.leave, display: 'inline-block', animation: 'hqpulse 1.2s ease-in-out infinite' }} />
);
export function Skeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, animation: 'hqpulse 1.4s ease-in-out infinite' }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ height: 14, width: '45%', borderRadius: 6, background: color.track }} />
          <div style={{ height: 12, width: '80%', borderRadius: 6, background: '#EEE9DD' }} />
          <div style={{ height: 12, width: '60%', borderRadius: 6, background: '#EEE9DD' }} />
        </div>
      ))}
    </div>
  );
}

type BadgeSize = 'sm' | 'md' | 'lg';
const BADGE_SIZE: Record<BadgeSize, CSSProperties> = {
  sm: { padding: '4px 8px', fontSize: 12 },
  md: { padding: '4px 10px', fontSize: 13 },
  lg: { padding: '5px 12px', fontSize: 14 },
};
/** Status pill — always icon + label so status never relies on colour alone. */
export function Badge({ kind, spec, size = 'md', style }: { kind?: BadgeKind; spec?: BadgeSpec; size?: BadgeSize; style?: CSSProperties }) {
  const b = spec || badgeSpec(kind!);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 999, fontWeight: 700, whiteSpace: 'nowrap', background: b.bg, color: b.fg, ...BADGE_SIZE[size], ...style }}>
      <Icon name={b.icon} size={18} />{b.label}
    </span>
  );
}

export function Avatar({ ini, size, fs, bg = color.sage, fg = color.primary }: { ini: string; size: number; fs: number; bg?: string; fg?: string }) {
  return <span aria-hidden="true" style={{ width: size, height: size, borderRadius: '50%', background: bg, color: fg, fontSize: fs, fontWeight: 800, display: 'grid', placeItems: 'center', flexShrink: 0 }}>{ini}</span>;
}

export function ProgressBar({ pct, h = 8, track = color.track }: { pct: number; h?: number; track?: string }) {
  return (
    <span style={{ display: 'block', width: '100%', height: h, borderRadius: h, background: track, overflow: 'hidden' }}>
      <span style={{ display: 'block', height: '100%', background: color.primary, width: `${pct}%` }} />
    </span>
  );
}

export function FieldError({ msg, fs = 13 }: { msg?: string | null; fs?: number }) {
  if (!msg) return null;
  return <p role="alert" style={{ margin: 0, fontSize: fs, color: color.danger, display: 'flex', gap: fs < 13 ? 4 : 6, alignItems: 'flex-start' }}><Icon name="alert" size={18} /> {msg}</p>;
}

/* ---------------- Controls ---------------- */
export type Opt<K extends string> = readonly [K, ReactNode];

/** Segmented control on the sand track. */
export function Segmented<K extends string>({ options, value, onChange, h = 44, fs = 15, role, label, gap = 4 }: {
  options: readonly Opt<K>[]; value: K; onChange: (k: K) => void; h?: number; fs?: number; role?: 'tablist' | 'group'; label?: string; gap?: number;
}) {
  return (
    <div role={role} aria-label={label} style={{ display: 'flex', background: color.sunken, borderRadius: 14, padding: 4, gap }}>
      {options.map(([k, l]) => {
        const on = k === value;
        return (
          <button key={k} role={role === 'tablist' ? 'tab' : undefined} aria-selected={role === 'tablist' ? on : undefined} aria-pressed={role === 'tablist' ? undefined : on}
            onClick={() => onChange(k)}
            style={{ flex: 1, minHeight: h, border: 'none', borderRadius: 11, background: on ? color.primary : 'transparent', color: on ? color.ivory : color.body, fontSize: fs, fontWeight: on ? 700 : 500, cursor: 'pointer', padding: '0 6px' }}>
            {l}
          </button>
        );
      })}
    </div>
  );
}

/** Filter / toggle chips with a check icon when selected. */
export function Chips<K extends string>({ options, value, onChange, h = 40, fs = 14, scroll = false, wrapStyle }: {
  options: readonly Opt<K>[]; value: K | K[]; onChange: (k: K) => void; h?: number; fs?: number; scroll?: boolean; wrapStyle?: CSSProperties;
}) {
  return (
    <div style={scroll ? { display: 'flex', gap: 8, overflowX: 'auto', margin: '0 -16px', paddingInline: 16, paddingBottom: 2, ...wrapStyle } : { display: 'flex', flexWrap: 'wrap', gap: 8, ...wrapStyle }}>
      {options.map(([k, l]) => {
        const on = Array.isArray(value) ? value.includes(k) : k === value;
        return (
          <button key={k} aria-pressed={on} onClick={() => onChange(k)} style={{
            minHeight: h, padding: '0 14px', borderRadius: 999, border: `1.5px solid ${on ? color.primary : color.borderChip}`,
            background: on ? color.sage : color.card, color: on ? color.primary : color.body, fontSize: fs, fontWeight: 700,
            whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', flexShrink: 0,
          }}>
            {on && <Icon name="check" size={18} />}{l}
          </button>
        );
      })}
    </div>
  );
}

export function Switch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={onToggle}
      style={{ width: 52, height: 32, borderRadius: 999, border: 'none', position: 'relative', cursor: 'pointer', flexShrink: 0, background: on ? color.primary : color.borderStrong }}>
      <span style={{ position: 'absolute', top: 4, width: 24, height: 24, borderRadius: '50%', background: color.card, right: on ? 24 : 4, transition: 'right .15s' }} />
    </button>
  );
}

export function BackHeader({ title, sticky = false, border = false, onBack = navBack }: { title: ReactNode; sticky?: boolean; border?: boolean; onBack?: () => void }) {
  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', minHeight: 56,
      ...(sticky ? { position: 'sticky', top: 0, background: color.ivory, zIndex: 5 } : {}),
      ...(border ? { borderBottom: `1px solid ${color.dividerHeader}` } : {}),
    }}>
      <BackButton onClick={onBack} />
      <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, flex: 1 }}>{title}</h1>
    </header>
  );
}
export function BackButton({ onClick = navBack, light = false, style }: { onClick?: () => void; light?: boolean; style?: CSSProperties }) {
  return (
    <button onClick={onClick} aria-label="رجوع" style={{ width: 48, height: 48, borderRadius: 14, border: 'none', background: 'transparent', color: light ? color.ivory : color.primary, display: 'grid', placeItems: 'center', cursor: 'pointer', ...style }}>
      <Icon name="chevR" />
    </button>
  );
}

/** Label/value rows inside a card (task detail, booking review, session details). */
export function KVCard({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <div style={{ ...card, padding: '4px 16px' }}>
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '12px 0', borderBottom: i < rows.length - 1 ? `1px solid ${color.divider}` : 'none' }}>
          <span style={{ fontSize: 14, color: color.muted }}>{k}</span>
          {typeof v === 'string' ? <span style={{ fontSize: 15, fontWeight: 700 }}>{v}</span> : v}
        </div>
      ))}
    </div>
  );
}

/** Centered status block (empty / error / success). */
export function StatusBlock({ icon, iconBg, iconFg, title, body, children, role = 'status', h = 'h2', titleFs = 20, style }: {
  icon: IconName; iconBg: string; iconFg: string; title: ReactNode; body?: ReactNode; children?: ReactNode; role?: 'status' | 'alert'; h?: 'h1' | 'h2' | 'p'; titleFs?: number; style?: CSSProperties;
}) {
  const T = h;
  return (
    <div role={role} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 12, ...style }}>
      <span style={{ ...iconTile(64, iconBg, iconFg), borderRadius: '50%' }}><Icon name={icon} size={30} /></span>
      <T style={{ margin: 0, fontSize: titleFs, fontWeight: T === 'p' ? 700 : 800 }}>{title}</T>
      {body && <p style={{ margin: 0, fontSize: 15, color: color.muted, lineHeight: 1.7, maxWidth: 290 }}>{body}</p>}
      {children}
    </div>
  );
}

/* ---------------- Audio player ---------------- */
export function usePlayer(key: string, dur: number, url?: string | null) {
  const p = useApp((s) => s.player);
  const mine = p.key === key; const pos = mine ? p.pos : 0; const playing = mine && p.playing;
  return {
    playing, pos, posL: fmt(pos), durL: fmt(dur), pct: dur ? Math.min(100, (pos / dur) * 100) : 0,
    toggle: () => playerToggle(key, dur, url),
    seekTo: (t: number) => playerSeek(key, dur, t),
    /** RTL track: progress grows from the right edge. */
    seekEvent: (e: MouseEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (r.right - e.clientX) / r.width));
      playerSeek(key, dur, ratio * dur);
    },
  };
}

export function PlayButton({ playing, onClick, size = 48, bg = color.primary, fg = color.ivory, label }: { playing: boolean; onClick: () => void; size?: number; bg?: string; fg?: string; label?: string }) {
  return (
    <button onClick={onClick} aria-label={label || (playing ? 'إيقاف مؤقت' : 'تشغيل')}
      style={{ width: size, height: size, borderRadius: '50%', border: 'none', background: bg, color: fg, display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0 }}>
      <Icon name={playing ? 'pause' : 'play'} />
    </button>
  );
}

/** Play button + seekable track (+ optional gold timestamp marks) + mm:ss counter. */
export function PlayerBar({ k, dur, url, notes, btnSize = 48, trackH = 32, showButton = true, timeOverride }: {
  k: string; dur: number; url?: string | null; notes?: TimedNote[]; btnSize?: number; trackH?: number; showButton?: boolean; timeOverride?: string;
}) {
  const pl = usePlayer(k, dur, url);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
      {showButton && <PlayButton playing={pl.playing} onClick={pl.toggle} size={btnSize} />}
      <div onClick={pl.seekEvent} role="slider" aria-label="شريط التشغيل" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(pl.pos)} aria-valuetext={`${pl.posL} من ${pl.durL}`} tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') pl.seekTo(Math.min(dur, pl.pos + 5));
          if (e.key === 'ArrowRight') pl.seekTo(Math.max(0, pl.pos - 5));
        }}
        style={{ flex: 1, height: trackH, display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
        <div style={{ width: '100%', height: 6, borderRadius: 6, background: color.track, position: 'relative' }}>
          <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, borderRadius: 6, background: color.primary, width: `${pl.pct}%` }} />
          {(notes || []).map((n, i) => (
            <span key={i} style={{ position: 'absolute', top: -5, width: 4, height: 16, borderRadius: 2, background: color.gold, right: `${dur ? (n.t / dur) * 100 : 0}%` }} />
          ))}
        </div>
      </div>
      <span dir="ltr" style={{ fontFamily: font.latin, fontSize: 13, color: color.muted }}>{timeOverride ?? `${pl.posL} / ${pl.durL}`}</span>
    </div>
  );
}

/* ---------------- Misc ---------------- */
export const Ltr = ({ children }: { children: ReactNode }) => <bdi dir="ltr" style={{ fontFamily: font.latin }}>{children}</bdi>;

export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div style={{ position: 'relative' }}>
      <span style={{ position: 'absolute', right: 14, top: 15, color: color.muted }}><Icon name="search" /></span>
      <input type="search" aria-label={placeholder} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)}
        style={{ width: '100%', minHeight: 52, padding: '0 46px 0 14px', borderRadius: 14, border: `1.5px solid ${color.borderInput}`, background: color.card, fontSize: 16, color: color.ink }} />
    </div>
  );
}
