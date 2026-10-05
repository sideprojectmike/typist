// Comparing what the field holds with what it should hold, and working out a
// repair. Pure; tested in test/verify.test.js.
//
// The only normalisation is for differences that aren't real text: CRLF vs LF,
// and the non-breaking spaces Chrome puts in contenteditable while typing.
export const normalize = (s) => s.replace(/\r\n?/g, '\n').replace(/ /g, ' ');

// state: { before, after } from page 'prepare'. typed: target text typed so far.
export const expectedText = (state, typed) => normalize(state.before + typed + state.after);

const graphemes = (s) => [...new Intl.Segmenter().segment(s)].length;

// What to do about a field that differs from what was expected.
//   { ok: true }                                 matches
//   { repair: { backspaces, retype, keep } }     fixable at the caret
//   { fail: reason }                             not safe or possible to fix
// Repairs only delete text this job typed. They never touch text that was in
// the field before, or text after the caret.
export function diagnose(actualRaw, expectedRaw, state) {
  const actual = normalize(actualRaw);
  const expected = normalize(expectedRaw);
  if (actual === expected) return { ok: true };

  const before = normalize(state.before);
  const after = normalize(state.after);
  if (!actual.endsWith(after)) return { fail: 'text after the caret changed during typing' };

  const actualTyped = actual.slice(0, actual.length - after.length);
  const expectedTyped = expected.slice(0, expected.length - after.length);
  let p = 0;
  while (p < actualTyped.length && p < expectedTyped.length && actualTyped[p] === expectedTyped[p]) p++;
  // Back off to a grapheme boundary so a backspace never splits a character.
  const segs = [...new Intl.Segmenter().segment(actualTyped)];
  const boundary = segs.reduce((b, s) => (s.index <= p ? s.index : b), 0);
  p = Math.min(p, p === actualTyped.length ? p : boundary);

  if (p < before.length || !actualTyped.startsWith(before)) {
    return { fail: 'text that was already in the field changed during typing' };
  }
  return {
    repair: {
      keep: actualTyped.slice(0, p),
      backspaces: graphemes(actualTyped.slice(p)),
      retype: expectedTyped.slice(p),
    },
  };
}

export function firstDifference(actualRaw, expectedRaw) {
  const a = normalize(actualRaw);
  const e = normalize(expectedRaw);
  let i = 0;
  while (i < a.length && a[i] === e[i]) i++;
  const around = (s) => JSON.stringify(s.slice(Math.max(0, i - 10), i + 10));
  return `at character ${i}: expected ${around(e)}, field has ${around(a)}`;
}

// Google Docs: where `text` was inserted to turn `before` into `after`, or -1.
// The caret position isn't known, so any single contiguous insertion counts.
export function insertedAt(beforeRaw, afterRaw, textRaw) {
  const [b, a, t] = [beforeRaw, afterRaw, textRaw].map(normalize);
  if (a.length !== b.length + t.length) return -1;
  let p = 0;
  while (p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < b.length && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  for (let i = b.length - s; i <= p; i++) if (a.startsWith(t, i)) return i;
  return -1;
}
