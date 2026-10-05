// Mistake engine: decides WHAT a mistake looks like at a position. It never
// decides how the mistake is corrected; the planner derives that from the
// target text, so a mistake kind cannot break correctness.
//
// Each kind returns { span, wrong, minTrail? } or null if it doesn't fit here:
//   span  - how many target characters the mistake replaces
//   wrong - what gets typed instead of those characters
//   minTrail - characters that must follow before the mistake is visible
import { flipCase, isLetter, isSafe, neighbors } from './keyboard.js';

export const KINDS = {
  substitution(chars, i, rng) {
    const near = neighbors(chars[i]);
    return near.length ? { span: 1, wrong: [rng.pick(near)] } : null;
  },
  omission(chars, i) {
    // A dropped character only shows once the next one is typed.
    return i + 1 < chars.length && isSafe(chars[i + 1]) ? { span: 1, wrong: [], minTrail: 1 } : null;
  },
  duplicate(chars, i) {
    return isLetter(chars[i]) ? { span: 1, wrong: [chars[i], chars[i]] } : null;
  },
  transposition(chars, i) {
    const [a, b] = [chars[i], chars[i + 1]];
    return b !== undefined && isLetter(a) && isLetter(b) && a !== b ? { span: 2, wrong: [b, a] } : null;
  },
  capitalization(chars, i) {
    return isLetter(chars[i]) ? { span: 1, wrong: [flipCase(chars[i])] } : null;
  },
};

export const WEIGHTS = {
  substitution: 0.5,
  omission: 0.2,
  duplicate: 0.15,
  transposition: 0.1,
  capitalization: 0.05,
};

// Weighted pick among the kinds that fit at position i.
export function pickMistake(chars, i, rng) {
  if (!isSafe(chars[i])) return null;
  const options = Object.entries(KINDS)
    .map(([kind, make]) => ({ kind, weight: WEIGHTS[kind], mistake: make(chars, i, rng) }))
    .filter((o) => o.mistake);
  if (!options.length) return null;
  let r = rng.next() * options.reduce((sum, o) => sum + o.weight, 0);
  const chosen = options.find((o) => (r -= o.weight) < 0) ?? options.at(-1);
  return { kind: chosen.kind, ...chosen.mistake };
}
