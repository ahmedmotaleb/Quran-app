// Unit test for the surah/ayah pickers' search (src/lib/quranSearch.ts, pure): Arabic normalization, name and number
// search in Mushaf order, ayah filtering within the surah's range. The few names below are test data for the search
// only; the app's names come from the verified source (quran/index).   node e2e/quran-search.test.mjs
import assert from 'node:assert/strict';
const { normalizeAr, searchSurahs, searchAyahs, latinDigits } = await import('../src/lib/quranSearch.ts');

const names = { 1: 'الفاتحة', 2: 'البقرة', 3: 'آل عمران', 5: 'المائدة', 18: 'الكهف', 36: 'يس', 55: 'الرحمن', 67: 'الملك', 112: 'الإخلاص', 113: 'الفلق', 114: 'الناس' };
const counts = [7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128, 111, 110, 98, 135, 112, 78, 118, 64, 77, 227, 93, 88,
  69, 60, 34, 30, 73, 54, 45, 83, 182, 88, 75, 85, 54, 53, 89, 59, 37, 35, 38, 29, 18, 45, 60, 49, 62, 55, 78, 96, 29, 22, 24, 13, 14, 11, 11,
  18, 12, 12, 30, 52, 52, 44, 28, 28, 20, 56, 40, 31, 50, 40, 46, 42, 29, 19, 36, 25, 22, 17, 19, 26, 30, 20, 15, 21, 11, 8, 8, 19, 5, 8, 8,
  11, 11, 8, 3, 9, 5, 4, 7, 3, 6, 3, 5, 4, 5, 6];
const all = counts.map((c, i) => ({ n: i + 1, name: names[i + 1] ?? `س${i + 1}`, count: c }));
let fails = 0;
const t = (name, fn) => { try { fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message); } };

t('normalization: hamza forms, ta marbuta, alef maqsura, diacritics, tatweel, «سورة», Arabic digits', () => {
  assert.equal(normalizeAr('الإخلاص'), 'الاخلاص');
  assert.equal(normalizeAr('آل عمران'), 'ال عمران');
  assert.equal(normalizeAr('البقرة'), 'البقره');
  assert.equal(normalizeAr('سُورَةُ ٱلْفَاتِحَةِ'), 'الفاتحه');
  assert.equal(normalizeAr('الكهـــف'), 'الكهف');
  assert.equal(latinDigits('٢٥٥'), '255');
});
t('empty search keeps all 114 in Mushaf order', () => assert.deepEqual(searchSurahs(all, '').map((s) => s.n), counts.map((_, i) => i + 1)));
t('«بق» → البقرة', () => assert.deepEqual(searchSurahs(all, 'بق').map((s) => s.n), [2]));
t('«كه» → الكهف', () => assert.deepEqual(searchSurahs(all, 'كه').map((s) => s.n), [18]));
t('«مل» → الملك (and only matches)', () => assert.ok(searchSurahs(all, 'مل').every((s) => s.name.includes('مل')) && searchSurahs(all, 'مل').some((s) => s.n === 67)));
t('«يس», «الناس», «الملك» exact', () => {
  assert.deepEqual(searchSurahs(all, 'يس').map((s) => s.n), [36]);
  assert.deepEqual(searchSurahs(all, 'الناس').map((s) => s.n), [114]);
  assert.deepEqual(searchSurahs(all, 'الملك').map((s) => s.n), [67]);
});
t('typing variants: «الاخلاص», «اخلاص», «سورة البقره», «المائده»', () => {
  assert.deepEqual(searchSurahs(all, 'الاخلاص').map((s) => s.n), [112]);
  assert.deepEqual(searchSurahs(all, 'اخلاص').map((s) => s.n), [112]);
  assert.deepEqual(searchSurahs(all, 'سورة البقره').map((s) => s.n), [2]);
  assert.deepEqual(searchSurahs(all, 'المائده').map((s) => s.n), [5]);
});
t('number search: «114», «١٨»', () => {
  assert.deepEqual(searchSurahs(all, '114').map((s) => s.n), [114]);
  assert.deepEqual(searchSurahs(all, '١٨').map((s) => s.n), [18]);
});
t('ayahs: البقرة 1–286, «255» → 255, «25» → 25 and 250–259', () => {
  assert.equal(searchAyahs(286, '').length, 286);
  assert.deepEqual(searchAyahs(286, '255'), [255]);
  assert.deepEqual(searchAyahs(286, '25'), [25, 250, 251, 252, 253, 254, 255, 256, 257, 258, 259]);
  assert.deepEqual(searchAyahs(286, '٢٥٥'), [255]);
});
t('ayahs never exceed the surah: الإخلاص only 1–4, الفاتحة «20» → none', () => {
  assert.deepEqual(searchAyahs(4, ''), [1, 2, 3, 4]);
  assert.deepEqual(searchAyahs(7, '20'), []);
  assert.deepEqual(searchAyahs(6, '20'), []);
});
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
