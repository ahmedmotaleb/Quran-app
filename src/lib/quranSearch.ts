/** Surah/ayah search for the pickers (pure: no imports, unit-tested by e2e/quran-search.test.ts). */
export interface SurahInfo { n: number; name: string; count: number }

const DIGITS: Record<string, string> = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
export const latinDigits = (s: string) => s.replace(/[٠-٩۰-۹]/g, (d) => DIGITS[d]);

/** Typing-tolerant Arabic: no diacritics or tatweel; أ/إ/آ/ٱ → ا, ة → ه, ى → ي, ؤ → و, ئ → ي; no «سورة» prefix. */
export function normalizeAr(s: string) {
  return latinDigits(s)
    .replace(/[ؐ-ًؚ-ٰٟۖ-ۭـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/^\s*سوره\s+/, '').replace(/\s+/g, ' ').trim();
}

/** Surahs matching what the teacher typed, in Mushaf order: a name fragment («بق», «كهف», «الملك») or a number. */
export function searchSurahs(all: SurahInfo[], q: string): SurahInfo[] {
  const t = normalizeAr(q);
  if (!t) return all;
  if (/^\d+$/.test(t)) return all.filter((s) => String(s.n).startsWith(t));
  const bare = t.replace(/^ال/, '');
  return all.filter((s) => { const n = normalizeAr(s.name); return n.includes(t) || (bare.length > 0 && n.includes(bare)); });
}

/** Ayah numbers 1…count that start with the typed digits («25» → 25, 250–259). */
export function searchAyahs(count: number, q: string): number[] {
  const t = latinDigits(q).replace(/\D/g, '');
  const all = Array.from({ length: count }, (_, i) => i + 1);
  return t ? all.filter((n) => String(n).startsWith(t)) : all;
}
