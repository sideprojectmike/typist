// Timing engine: gives every op a `delay` (ms to wait before performing it)
// and key ops a `hold` (ms between keyDown and keyUp).
//
// WPM sets the pace of ordinary keystrokes. Context effects (slower after
// punctuation, faster on common bigrams) are normalised over the target text
// so they shape the rhythm without changing the overall pace. Mistakes,
// corrections and thinking pauses then add real time on top: nothing is
// sped up to compensate, so a run with mistakes takes longer, as it would for
// a person. Effective WPM is measured after the run.
const COMMON_BIGRAMS = new Set(['th', 'he', 'in', 'er', 'an', 're', 'on', 'at', 'en', 'nd', 'ti', 'es', 'or', 'te', 'of', 'ed', 'is', 'it', 'al', 'ar', 'st', 'to', 'nt', 'ng', 'se', 'ha', 'ou']);
const THINK_CHANCE = 0.02; // chance of a longer pause before a word
const THINK_MS = [400, 1200];
const MIN_DELAY = 20;
const HOLD_MS = 70; // typical key dwell time

export const msPerChar = (wpm) => 12000 / wpm; // one word = 5 characters

// Pause before a request starts typing: pause_before_typing ± jitter seconds,
// picked uniformly, never below zero. `random` returns a number in [0, 1).
export function pauseBeforeTypingMs(settings, random = Math.random) {
  const base = settings.pause_before_typing ?? 0;
  const jitter = settings.pause_before_typing_jitter ?? 0;
  return Math.round(Math.max(0, base + (2 * random() - 1) * jitter) * 1000);
}

function contextFactor(prev, ch) {
  let f = 1;
  if (prev === undefined) return f;
  if ('.!?'.includes(prev)) f *= 2.5;
  else if (',;:'.includes(prev)) f *= 1.6;
  else if (prev === '\n') f *= 2;
  else if (prev === ' ') f *= 1.2;
  if (COMMON_BIGRAMS.has((prev + ch).toLowerCase())) f *= 0.75;
  else if (prev === ch) f *= 0.85;
  if (ch !== ch.toLowerCase()) f *= 1.15; // reaching for Shift
  if (ch === '\n') f *= 1.8;
  return f;
}

export function assignDelays(ops, text, settings, rng) {
  const sigma = settings.variation;
  const jitter = () => Math.exp(sigma * rng.normal() - (sigma * sigma) / 2); // mean 1

  // Mean context factor over the text as written, so `base` is the pace that
  // makes clean typing of this text come out at the requested WPM.
  const chars = Array.from(text);
  const meanFactor = chars.length > 1
    ? chars.slice(1).reduce((sum, ch, i) => sum + contextFactor(chars[i], ch), 0) / (chars.length - 1)
    : 1;
  const base = msPerChar(settings.wpm) / meanFactor;

  let prev;
  const timed = ops.map((op) => {
    if (op.type === 'key') {
      let delay = base * contextFactor(prev, op.char) * jitter();
      if ((prev === ' ' || prev === '\n') && rng.chance(THINK_CHANCE)) delay += rng.float(...THINK_MS);
      if (prev === undefined) delay = 0; // first key goes immediately
      prev = op.char;
      return { ...op, delay };
    }
    if (op.type === 'backspace') return { ...op, delay: base * 0.6 * jitter() };
    if (op.type === 'notice') {
      const { min, max } = settings.correction_pause;
      return { ...op, delay: rng.float(min, max) };
    }
    return { ...op, delay: 0 };
  });

  let duration = 0;
  const result = timed.map((op, n) => {
    const delay = op.type === 'checkpoint' || n === 0 ? Math.round(op.delay) : Math.max(MIN_DELAY, Math.round(op.delay));
    duration += delay;
    if (op.type !== 'key' && op.type !== 'backspace') return { ...op, delay };
    // Key held for a natural dwell, but never past half the gap to the next key.
    let j = n + 1;
    while (timed[j]?.type === 'checkpoint') j++;
    const hold = Math.round(Math.min(HOLD_MS * jitter(), (timed[j]?.delay ?? HOLD_MS * 2) / 2));
    return { ...op, delay, hold: Math.max(5, hold) };
  });
  return { ops: result, duration_ms: duration };
}
