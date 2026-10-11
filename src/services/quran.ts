/**
 * Real Quran text source: Tanzil Uthmani script via the alquran.cloud API.
 * Rule from the brief: never render Quran text from anywhere but a trusted source —
 * on failure the UI shows an error state, never generated/placeholder text.
 */
import type { SurahData, SurahListItem } from '@/data/types';

const API = 'https://api.alquran.cloud/v1';
const cache = new Map<number, SurahData>();

export async function fetchSurah(n: number): Promise<SurahData> {
  const hit = cache.get(n);
  if (hit) return hit;
  const r = await fetch(`${API}/surah/${n}/quran-uthmani`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j?.data?.ayahs) throw new Error('Malformed response');
  const d: SurahData = {
    number: j.data.number,
    name: j.data.name,
    numberOfAyahs: j.data.numberOfAyahs,
    ayahs: j.data.ayahs.map((a: { numberInSurah: number; text: string; juz: number }) => ({ numberInSurah: a.numberInSurah, text: a.text, juz: a.juz })),
  };
  cache.set(n, d);
  return d;
}

export async function fetchSurahList(): Promise<SurahListItem[]> {
  const r = await fetch(`${API}/surah`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return j.data.map((x: { number: number; name: string; numberOfAyahs: number }) => ({ n: x.number, name: x.name, c: x.numberOfAyahs }));
}

/** Per-ayah recitation audio (Mishary Alafasy, 128kbps) from everyayah.com. */
export const ayahAudioUrl = (surah: number, ayah: number) =>
  `https://everyayah.com/data/Alafasy_128kbps/${String(surah).padStart(3, '0')}${String(ayah).padStart(3, '0')}.mp3`;
