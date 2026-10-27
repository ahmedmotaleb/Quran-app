/** The 114-surah index every picker and Quran reference uses (mistakes, tasks, cards). One source of truth: the
 *  server's `quran/index` — names from the verified Tanzil import, ayah counts from the Hafs table the import is
 *  checked against. Never a hand-typed list. Cached in memory (and in this browser, as a speed-up only). */
import { useEffect, useSyncExternalStore } from 'react';
import { LIVE, api } from '@/api/client';
import { fetchSurahList } from '@/services/quran';

import type { SurahInfo } from './quranSearch';

export type { SurahInfo };
interface ApiIndex { source: string | null; verified: boolean; surahs: { number: number; name_ar: string; ayah_count: number }[] }

const KEY = 'halqa.surahIndex.v1';
let list: SurahInfo[] | null = readStored();
let pending: Promise<SurahInfo[]> | null = null;
let failed = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function readStored(): SurahInfo[] | null {
  try {
    const x = JSON.parse(localStorage.getItem(KEY) || 'null') as SurahInfo[] | null;
    return Array.isArray(x) && x.length === 114 && x.every((s, i) => s.n === i + 1 && s.name && s.count > 0) ? x : null;
  } catch { return null; }
}

/** Load (once) the index. Live: the server; demo: the public Tanzil-based list the demo Mushaf already reads. */
export function loadSurahIndex(): Promise<SurahInfo[]> {
  if (list) return Promise.resolve(list);
  pending ??= (async () => {
    const got: SurahInfo[] = LIVE
      ? (await api<ApiIndex>('GET', 'quran/index')).surahs.map((s) => ({ n: s.number, name: s.name_ar, count: s.ayah_count }))
      : (await fetchSurahList()).map((s) => ({ n: s.n, name: s.name.replace(/^سُورَةُ\s*/, '').replace(/^سورة\s*/, ''), count: s.c }));
    if (got.length !== 114) throw new Error('incomplete surah index');
    list = got; failed = false;
    try { if (got.every((s) => s.name)) localStorage.setItem(KEY, JSON.stringify(got)); } catch { /* speed-up only */ }
    emit();
    return got;
  })().catch((e) => { failed = true; emit(); throw e; }).finally(() => { pending = null; });
  return pending;
}

const snapshot = () => list;
/** The index for components (re-renders when it arrives); `retry` after a failure. Loads on first use. */
export function useSurahIndex(load = true) {
  const l = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, snapshot, snapshot);
  useEffect(() => { if (load && !l) loadSurahIndex().catch(() => {}); }, [load, l]);
  return { list: l, failed: !l && failed, retry: () => { failed = false; emit(); loadSurahIndex().catch(() => {}); } };
}

export const surahInfo = (n: number): SurahInfo | undefined => (list && n >= 1 && n <= 114 ? list[n - 1] : undefined);
export const ayahCount = (n: number) => surahInfo(n)?.count ?? 0;
/** «البقرة»; «سورة 2» only until the index has arrived (or before the Quran text is imported). */
export const surahLabel = (n: number) => surahInfo(n)?.name || `سورة ${n}`;
/** The one reference formatter: «البقرة — الآية 255», compact «البقرة · 255». */
export const formatRef = (surah: number, ayah: number, compact = false) =>
  compact ? `${surahLabel(surah)} · ${ayah}` : `${surahLabel(surah)} — الآية ${ayah}`;

export { latinDigits, normalizeAr, searchAyahs, searchSurahs } from './quranSearch';
