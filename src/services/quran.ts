/**
 * Quran text sources. Rule from the brief: never render Quran text from anywhere but a
 * trusted source — on failure the UI shows an error state, never generated/placeholder text.
 * - Live mode: the backend's imported, checksum-verified copy (GET /api/v1/quran/…).
 *   No silent fallback: if the server has no active source, the Mushaf shows the error.
 * - Demo mode: Tanzil Uthmani via the alquran.cloud API.
 */
import type { SurahData, SurahListItem } from '@/data/types';
import { LIVE, api } from '@/api/client';
import { surahAudio, type AyahAudioCfg } from '@/api/endpoints';

const API = 'https://api.alquran.cloud/v1';
const cache = new Map<number, SurahData>();

export async function fetchSurah(n: number): Promise<SurahData> {
  const hit = cache.get(n);
  if (hit) return hit;
  if (LIVE) {
    const j = await api<ApiSurahText>('GET', `quran/surahs/${n}`);
    const d: SurahData = {
      number: j.surah.number, name: `سورة ${j.surah.name_ar}`, numberOfAyahs: j.surah.ayah_count,
      ayahs: j.ayahs.map((a) => ({ numberInSurah: a.number, text: a.text, juz: a.juz })),
    };
    cache.set(n, d);
    return d;
  }
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
  if (LIVE) return (await api<ApiSurah[]>('GET', 'quran/surahs')).map((x) => ({ n: x.number, name: `سورة ${x.name_ar}`, c: x.ayah_count }));
  const r = await fetch(`${API}/surah`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return j.data.map((x: { number: number; name: string; numberOfAyahs: number }) => ({ n: x.number, name: x.name, c: x.numberOfAyahs }));
}

const pad3 = (n: number) => String(n).padStart(3, '0');
/** Per-ayah recitation audio. Live mode: only the source the server approves (`ayah_audio` in public settings;
 *  null = no licensed source yet, no audio). Demo: Mishary Alafasy from everyayah.com. */
export const ayahAudioUrl = (surah: number, ayah: number, cfg?: AyahAudioCfg | null, reciter?: number | null) => {
  if (!LIVE) return `https://everyayah.com/data/Alafasy_128kbps/${pad3(surah)}${pad3(ayah)}.mp3`;
  if (!cfg) return null;
  if (cfg.provider === 'qf') return qfAudio.get(qfKey(surah, reciter))?.[String(ayah)] ?? null;
  return cfg.url ? cfg.url.replace('{surah}', pad3(surah)).replace('{ayah}', pad3(ayah)) : null;
};

/** Quran Foundation: the server returns one surah's ayah audio URLs per reciter; kept for this page session only. */
const qfAudio = new Map<string, Record<string, string>>();
const qfPending = new Map<string, Promise<void>>();
const qfKey = (surah: number, reciter?: number | null) => `${reciter ?? 0}:${surah}`;
/** When the chosen reciter has no audio for a surah the server plays another offered reciter; its name, per surah. */
const qfFallback = new Map<string, string>();
export function fallbackReciter(surah: number, reciter?: number | null) { return qfFallback.get(qfKey(surah, reciter)) ?? null; }
export function hasSurahAudio(surah: number, reciter?: number | null) { return qfAudio.has(qfKey(surah, reciter)); }
export function loadSurahAudio(surah: number, reciter?: number | null): Promise<void> {
  const k = qfKey(surah, reciter);
  if (qfAudio.has(k)) return Promise.resolve();
  let p = qfPending.get(k);
  if (!p) {
    p = surahAudio(surah, reciter).then((r) => {
      qfAudio.set(k, r.ayahs);
      if (r.requested && r.reciter_id !== r.requested) qfFallback.set(k, r.reciter); else qfFallback.delete(k);
    }).finally(() => qfPending.delete(k));
    qfPending.set(k, p);
  }
  return p;
}

/** The reciter offered by the server that this device chose last (or the server's default). */
const RECITER_KEY = 'halqa.reciter';
export function currentReciter(cfg?: AyahAudioCfg | null): { id: number; name: string } | null {
  const list = cfg?.reciters ?? [];
  if (!list.length) return null;
  let saved: number | null = null;
  try { saved = Number(localStorage.getItem(RECITER_KEY)) || null; } catch { /* storage unavailable */ }
  return list.find((r) => r.id === saved) ?? list.find((r) => r.id === cfg?.default) ?? list[0];
}
export function saveReciter(id: number) { try { localStorage.setItem(RECITER_KEY, String(id)); } catch { /* storage unavailable */ } }

/** One ayah ("surah:ayah", e.g. "1:1") in Uthmani script. */
export async function fetchAyah(ref: string): Promise<string> {
  const r = await fetch(`${API}/ayah/${ref}/quran-uthmani`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (typeof j?.data?.text !== 'string') throw new Error('Malformed response');
  return j.data.text;
}

interface ApiSurah { number: number; name_ar: string; name_en: string; ayah_count: number; revelation: string }
interface ApiSurahText { source: string; surah: ApiSurah; ayahs: { number: number; text: string; juz: number; page: number | null }[] }
