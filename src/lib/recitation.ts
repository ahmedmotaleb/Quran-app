/** Ayah-by-ayah recitation order for the Mushaf player (pure, so `e2e/recitation.test.mjs` can test it).
 *
 *  Two independent features:
 *  - Ayah repetition (`repeat`): each ayah is played `repeat` complete times before the next one (0 = ∞: the
 *    current ayah repeats until the reader stops, changes the setting or leaves).
 *  - Range loop (`loop`): after the last ayah of the range has finished all its repetitions, start the range again.
 *  - `adv` («متابعة بعد نهاية النطاق»): when not looping, carry on past the range to the end of the surah, each ayah
 *    still repeated `repeat` times.
 *
 *  `rep` is the 0-based number of the play now running for the current ayah (0 = first time). The store keeps it, so
 *  a pause/resume, a speed change or a reciter change does not lose it; the setting is read when an ayah ENDS, so
 *  changing ×3 → ×5 during playback applies at once. */
export interface Recital {
  from: number; to: number;   // the selected range (inclusive)
  last: number;               // the surah's last ayah
  cur: number;                // the ayah that just finished
  rep: number;                // which play of `cur` just finished (0-based)
  repeat: number;             // 1, 3, 5, 10 … or 0 = ∞
  loop: boolean;              // range loop
  adv: boolean;               // carry on past the range
}
export type Step = { ayah: number; rep: number } | null;

/** What to play after `cur` finished: the same ayah again, the next ayah, the range start again, or nothing. */
export function nextAfterEnded(s: Recital): Step {
  if (s.repeat === 0 || s.rep + 1 < s.repeat) return { ayah: s.cur, rep: s.rep + 1 };   // same ayah again
  const end = s.loop ? s.to : s.adv ? s.last : s.to;
  if (s.cur < end) return { ayah: s.cur + 1, rep: 0 };                                    // next ayah, fresh count
  if (s.loop && s.from <= s.to) return { ayah: s.from, rep: 0 };                          // range loop
  return null;                                                                            // done
}

/** The full play order from `from` (for tests and the status line); `cap` stops infinite modes. */
export function playOrder(s: Omit<Recital, 'cur' | 'rep'>, cap = 200): number[] {
  const out: number[] = [];
  let step: Step = s.from <= s.to ? { ayah: s.from, rep: 0 } : null;
  while (step && out.length < cap) {
    out.push(step.ayah);
    step = nextAfterEnded({ ...s, cur: step.ayah, rep: step.rep });
  }
  return out;
}

/** «التكرار ٢ من ٣» / «التكرار ٤ · مستمر» (Western digits, as the rest of the player). */
export const repLabel = (rep: number, repeat: number) => (repeat === 0 ? `التكرار ${rep + 1} · مستمر` : `التكرار ${rep + 1} من ${repeat}`);
