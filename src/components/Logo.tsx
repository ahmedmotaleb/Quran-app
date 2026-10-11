import { color, font } from '@/theme/tokens';
import { BRAND } from '@/theme/brand';

/**
 * Full logo: the emblem image above a live-text wordmark (Arabic name + spaced Latin name).
 * Replaces the raster halqa-logo.png, whose baked-in lettering no longer matches the name.
 * `size` is the emblem's width in px; the wordmark scales with it.
 */
export function Logo({ size, ivory = false }: { size: number; ivory?: boolean }) {
  const ink = ivory ? color.ivory : color.primary;
  return (
    <div role="img" aria-label={`${BRAND.ar} ${BRAND.en}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: size * 0.04, position: 'relative' }}>
      <img src={ivory ? '/assets/halqa-mark-ivory.png' : '/assets/halqa-mark.png'} alt="" style={{ width: size, height: size, objectFit: 'contain' }} />
      <span aria-hidden="true" style={{ fontFamily: font.ui, fontWeight: 800, fontSize: size * 0.36, lineHeight: 1.1, color: ink }}>{BRAND.ar}</span>
      <span aria-hidden="true" dir="ltr" style={{ fontFamily: font.latin, fontWeight: 700, fontSize: Math.max(10, size * 0.1), letterSpacing: '0.45em', marginInlineEnd: '-0.45em', color: ink }}>{BRAND.en}</span>
    </div>
  );
}
