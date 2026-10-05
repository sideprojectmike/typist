import { createRng } from '../extension/engine/rng.js';
import { DEFAULTS } from '../extension/engine/settings.js';

export const settings = (over = {}) => ({ ...DEFAULTS, ...over });

const PIECES = [
  ...'abcdefghijklmnopqrstuvwxyz', ...'abcdefghijklmnopqrstuvwxyz', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789', ...'.,;:!?\'"-()', ' ', ' ', ' ', ' ', '\n', '\t', 'é', 'ß', '😀', '👍🏽', '中',
];

export function randomText(seed, maxLen = 80) {
  const rng = createRng(seed);
  return Array.from({ length: rng.int(0, maxLen) }, () => rng.pick(PIECES)).join('');
}

// Replays a plan and calls fn(op, buffer) after each op.
export function walk(ops, fn) {
  const buf = [];
  for (const op of ops) {
    if (op.type === 'key') buf.push(op.char);
    if (op.type === 'backspace') buf.pop();
    fn(op, buf);
  }
  return buf;
}

export const PROSE = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs! '
  + 'How vexingly quick daft zebras jump; sphinx of black quartz, judge my vow. ';
