// Typing planner: turns target text into a sequence of key operations,
// including temporary mistakes and their corrections. No timing here.
//
// Ops:
//   { type: 'key', char }            type one character
//   { type: 'backspace' }            delete one character
//   { type: 'notice', kind }         the typist spots a mistake (timing turns this into a pause)
//   { type: 'checkpoint', at }       field should now hold exactly target[0..at)
import { assertPlan } from './buffer.js';
import { isSafe } from './keyboard.js';
import { pickMistake } from './mistakes.js';

const key = (char) => ({ type: 'key', char });
const isBreak = (ch) => ch === ' ' || ch === '\n' || ch === '\t';

export function buildPlan(text, settings, rng) {
  const chars = Array.from(text);
  const rate = settings.mistakes_enabled ? settings.mistake_rate : 0;
  const ops = [];
  let i = 0;

  while (i < chars.length) {
    const episode = rate > 0 && rng.chance(rate) ? planMistake(chars, i, settings.detection_delay, rng) : null;
    if (episode) {
      ops.push(...episode.ops);
      i = episode.end;
    } else {
      ops.push(key(chars[i]));
      i++;
    }
    // Checkpoint after each word, and at the end. The buffer is always clean
    // here: a mistake episode finishes its correction before returning.
    if (i === chars.length || isBreak(chars[i - 1])) ops.push({ type: 'checkpoint', at: i });
  }
  if (!chars.length) ops.push({ type: 'checkpoint', at: 0 });

  assertPlan(ops, text); // runtime guard, not just a test: a bad plan never reaches the page
  return ops;
}

// One mistake episode: type the wrong characters, keep going for a few
// characters (detection delay), notice, backspace to the first wrong
// character, retype correctly. The correction is derived from the target,
// so the episode always ends on the correct text.
function planMistake(chars, i, delay, rng) {
  const mistake = pickMistake(chars, i, rng);
  if (!mistake) return null;
  const start = i + mistake.span;

  // Characters typed past the mistake stay printable ASCII on the same line,
  // so a pending mistake never rides through Enter.
  let available = 0;
  while (available < delay.max && start + available < chars.length && isSafe(chars[start + available])) available++;
  const minTrail = mistake.minTrail ?? 0;
  if (available < minTrail) return null;
  const trail = rng.int(Math.min(Math.max(delay.min, minTrail), available), available);

  const end = start + trail;
  const correct = chars.slice(i, end);
  const typed = [...mistake.wrong, ...chars.slice(start, end)];
  let keep = 0;
  while (keep < typed.length && typed[keep] === correct[keep]) keep++;

  return {
    end,
    ops: [
      ...typed.map(key),
      { type: 'notice', kind: mistake.kind },
      ...Array.from({ length: typed.length - keep }, () => ({ type: 'backspace' })),
      ...correct.slice(keep).map(key),
    ],
  };
}
