// Unit test for src/lib/recitation.ts (pure): each AYAH repeats ×1/×3/×5/×10/∞ before the next one; range
// boundaries; range loop independent of ayah repetition; carrying on past the range; changing the setting while
// playing.   node --experimental-strip-types e2e/recitation.test.mjs
import assert from 'node:assert/strict';
const { nextAfterEnded, playOrder, repLabel } = await import('../src/lib/recitation.ts');
let fails = 0;
const t = (name, fn) => { try { fn(); console.log('OK  ', name); } catch (e) { fails++; console.log('FAIL', name, e.message); } };
const base = { from: 1, to: 3, last: 7, repeat: 1, loop: false, adv: false };
const each = (list, n) => list.flatMap((a) => Array(n).fill(a));

t('×1: each ayah once, then stop', () => assert.deepEqual(playOrder({ ...base, repeat: 1 }), [1, 2, 3]));
t('×3: Al-Baqarah 1–3 → 1 1 1, 2 2 2, 3 3 3, then stop', () => assert.deepEqual(playOrder({ ...base, repeat: 3 }), [1, 1, 1, 2, 2, 2, 3, 3, 3]));
t('×5', () => assert.deepEqual(playOrder({ ...base, repeat: 5 }), each([1, 2, 3], 5)));
t('×10', () => assert.deepEqual(playOrder({ ...base, repeat: 10 }), each([1, 2, 3], 10)));
t('∞: the first ayah repeats until stopped (never advances)', () => {
  const o = playOrder({ ...base, repeat: 0 }, 50);
  assert.equal(o.length, 50); assert.ok(o.every((a) => a === 1));
});
t('range boundaries: a one-ayah range, a range in the middle, the last ayah of the surah', () => {
  assert.deepEqual(playOrder({ ...base, from: 2, to: 2, repeat: 3 }), [2, 2, 2]);
  assert.deepEqual(playOrder({ ...base, from: 4, to: 5, repeat: 2 }), [4, 4, 5, 5]);
  assert.deepEqual(playOrder({ ...base, from: 7, to: 7, repeat: 2, adv: true }), [7, 7]);   // nothing after the surah's end
  assert.deepEqual(playOrder({ ...base, from: 3, to: 2 }), []);                              // empty range
});
t('range loop with ×3: the range restarts and each ayah still plays 3 times', () => {
  assert.deepEqual(playOrder({ ...base, from: 1, to: 2, repeat: 3, loop: true }, 15), [1, 1, 1, 2, 2, 2, 1, 1, 1, 2, 2, 2, 1, 1, 1]);
});
t('range loop with ×1', () => assert.deepEqual(playOrder({ ...base, repeat: 1, loop: true }, 7), [1, 2, 3, 1, 2, 3, 1]));
t('ayah repetition alone never loops the range', () => assert.deepEqual(playOrder({ ...base, from: 1, to: 2, repeat: 2 }), [1, 1, 2, 2]));
t('carry on past the range: to the end of the surah, still ×2 each; the loop takes precedence', () => {
  assert.deepEqual(playOrder({ ...base, from: 5, to: 5, repeat: 2, adv: true }), [5, 5, 6, 6, 7, 7]);
  assert.deepEqual(playOrder({ ...base, from: 5, to: 5, repeat: 1, adv: true, loop: true }, 4), [5, 5, 5, 5]);
});
t('changing the setting while playing applies when the ayah ends', () => {
  // second play of ayah 1 under ×3, switched to ×5: three more plays of ayah 1
  assert.deepEqual(nextAfterEnded({ ...base, cur: 1, rep: 1, repeat: 5 }), { ayah: 1, rep: 2 });
  // fourth play of ayah 1 under ×5, switched to ×3: already done → next ayah with a fresh count
  assert.deepEqual(nextAfterEnded({ ...base, cur: 1, rep: 3, repeat: 3 }), { ayah: 2, rep: 0 });
  // ∞ switched to ×1 after many plays: move on
  assert.deepEqual(nextAfterEnded({ ...base, cur: 2, rep: 40, repeat: 1 }), { ayah: 3, rep: 0 });
  // ×3 switched to ∞: keep repeating
  assert.deepEqual(nextAfterEnded({ ...base, cur: 2, rep: 2, repeat: 0 }), { ayah: 2, rep: 3 });
});
t('the range shrunk while playing past its end: stop (or loop back)', () => {
  assert.equal(nextAfterEnded({ ...base, to: 2, cur: 3, rep: 0 }), null);
  assert.deepEqual(nextAfterEnded({ ...base, to: 2, cur: 3, rep: 0, loop: true }), { ayah: 1, rep: 0 });
});
t('status text', () => {
  assert.equal(repLabel(1, 3), 'التكرار 2 من 3');
  assert.equal(repLabel(4, 0), 'التكرار 5 · مستمر');
});
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0;
