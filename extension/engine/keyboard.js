export const isLetter = (ch) => /^[a-zA-Z]$/.test(ch);
export const isDigit = (ch) => /^[0-9]$/.test(ch);
export const flipCase = (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase());

// QWERTY geometry for plausible adjacent-key typos.
const ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

// Rows are staggered: the row above sits half a key right, so key (r, c)
// touches (r-1, c) and (r-1, c+1) above, and (r+1, c-1) and (r+1, c) below.
const NEIGHBORS = new Map();
ROWS.forEach((row, r) => {
  [...row].forEach((key, c) => {
    const near = [
      ROWS[r][c - 1], ROWS[r][c + 1],
      ROWS[r - 1]?.[c], ROWS[r - 1]?.[c + 1],
      ROWS[r + 1]?.[c - 1], ROWS[r + 1]?.[c],
    ].filter(Boolean);
    // Keep letters near letters and digits near digits; "teat" reads as a
    // typo, "te5t" reads as noise.
    NEIGHBORS.set(key, near.filter((k) => isDigit(k) === isDigit(key)));
  });
});

// Only printable ASCII takes part in mistakes. Backspace then always removes
// exactly one planned character (no surrogate pairs, combining marks, or
// newlines that might submit a form).
export const isSafe = (ch) => ch.length === 1 && ch >= ' ' && ch <= '~';

export function neighbors(ch) {
  const near = NEIGHBORS.get(ch.toLowerCase()) ?? [];
  return ch === ch.toUpperCase() && isLetter(ch) ? near.map((k) => k.toUpperCase()) : near;
}
