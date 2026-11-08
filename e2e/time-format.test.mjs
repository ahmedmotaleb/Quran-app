// Unit test for src/lib/time.ts (pure): 12-hour Arabic times «٢:٣٠ مساءً», the device's IANA zone, Cairo daylight
// saving time from the zone database (never a fixed UTC+2), travellers, DST-safe wall-clock → instant.
//   node --experimental-strip-types e2e/time-format.test.mjs
import assert from 'node:assert/strict';
const T = await import('../src/lib/time.ts');
let fails = 0;
const t = (name, fn) => { try { fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message); } };

t('14:30 → ٢:٣٠ مساءً, 09:00 → ٩:٠٠ صباحًا', () => {
  assert.equal(T.clock(14, 30), '٢:٣٠ مساءً');
  assert.equal(T.clock(9, 0), '٩:٠٠ صباحًا');
  assert.equal(T.clockOf('14:30'), '٢:٣٠ مساءً');
  assert.equal(T.clockOf('09:00:00'), '٩:٠٠ صباحًا');
});
t('midnight and noon', () => {
  assert.equal(T.clock(0, 0), '١٢:٠٠ صباحًا');
  assert.equal(T.clock(12, 0), '١٢:٠٠ مساءً');
  assert.equal(T.clock(23, 59), '١١:٥٩ مساءً');
  assert.equal(T.hourLabel(20), '٨:٠٠ مساءً');
});
t('Cairo summer (UTC+3) and winter (UTC+2) from the IANA database', () => {
  assert.equal(T.fmtTime('2026-06-10T11:30:00Z', 'Africa/Cairo'), '٢:٣٠ مساءً');
  assert.equal(T.fmtTime('2026-12-10T12:30:00Z', 'Africa/Cairo'), '٢:٣٠ مساءً');
  assert.equal(T.gmtOffset('Africa/Cairo', Date.parse('2026-06-10T12:00:00Z')), 'GMT+3');
  assert.equal(T.gmtOffset('Africa/Cairo', Date.parse('2026-12-10T12:00:00Z')), 'GMT+2');
});
t('Cairo DST changes: fall-back night and spring-forward night', () => {
  // 29 Oct 2026 24:00 → 23:00 (23:30 happens twice)
  assert.equal(T.fmtTime('2026-10-29T20:30:00Z', 'Africa/Cairo'), '١١:٣٠ مساءً');
  assert.equal(T.fmtTime('2026-10-29T21:30:00Z', 'Africa/Cairo'), '١١:٣٠ مساءً');
  // 24 Apr 2026 00:00 → 01:00
  assert.equal(T.fmtTime('2026-04-23T21:59:00Z', 'Africa/Cairo'), '١١:٥٩ مساءً');
  assert.equal(T.fmtTime('2026-04-23T22:00:00Z', 'Africa/Cairo'), '١:٠٠ صباحًا');
});
t('a traveller sees the same instant in the device zone', () => {
  const iso = '2026-11-08T12:30:00Z';
  assert.equal(T.fmtTime(iso, 'Africa/Cairo'), '٢:٣٠ مساءً');
  assert.equal(T.fmtTime(iso, 'Asia/Riyadh'), '٣:٣٠ مساءً');
  assert.equal(T.fmtTime(iso, 'America/New_York'), '٧:٣٠ صباحًا');
  assert.equal(T.fmtTime(iso, 'Asia/Tokyo'), '٩:٣٠ مساءً');
});
t('wall clock → instant is DST-safe (booking a time keeps it)', () => {
  assert.equal(T.zonedToIso('2026-06-10', '14:30', 'Africa/Cairo'), '2026-06-10T11:30:00.000Z');
  assert.equal(T.zonedToIso('2026-12-10', '14:30', 'Africa/Cairo'), '2026-12-10T12:30:00.000Z');
  for (const d of ['2026-06-10', '2026-12-10']) assert.equal(T.fmtTime(T.zonedToIso(d, '14:30', 'Africa/Cairo'), 'Africa/Cairo'), '٢:٣٠ مساءً');
});
t('device zone comes from Intl and falls back to Africa/Cairo', () => {
  assert.equal(T.deviceZone(), Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Cairo');
  assert.equal(T.validZone('Africa/Cairo'), true);
  assert.equal(T.validZone('Mars/Base'), false);
});
t('labels and dates are Arabic', () => {
  assert.equal(T.zoneLabel('Africa/Cairo', Date.parse('2026-12-10T12:00:00Z')), 'بتوقيت القاهرة (GMT+2)');
  assert.equal(T.fmtDay('2026-11-08T12:30:00Z', 'Africa/Cairo'), 'الأحد ٨ نوفمبر');
  assert.equal(T.fmtDateTime('2026-11-08T12:30:00Z', 'Africa/Cairo'), 'الأحد ٨ نوفمبر، ٢:٣٠ مساءً');
  const now = new Date('2026-11-08T10:00:00Z');
  assert.equal(T.fmtRelative('2026-11-08T18:00:00Z', 'Africa/Cairo', now), 'اليوم، ٨:٠٠ مساءً');
  assert.equal(T.fmtRelative('2026-11-09T07:00:00Z', 'Africa/Cairo', now), 'غدًا، ٩:٠٠ صباحًا');
});
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
