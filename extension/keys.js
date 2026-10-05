// Characters -> CDP Input.dispatchKeyEvent parameters for a US QWERTY keyboard.
//
// Printable ASCII is sent as physical key presses (keyDown with `text`, then
// keyUp), with a real Shift press around shifted characters. Everything else
// (accented letters, CJK, emoji, tab) has no single US key, so it goes through
// Input.insertText, the same path an IME commit takes. Verification checks the
// result either way. scripts/probe-cdp.js checks this table against real Chrome.

const SHIFT_MOD = 8;

const SHIFTED_OF = {
  '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/',
};
const PUNCT = {
  ' ': ['Space', 32], '`': ['Backquote', 192], '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219],
  ']': ['BracketRight', 221], '\\': ['Backslash', 220], ';': ['Semicolon', 186], "'": ['Quote', 222],
  ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191],
};

const SHIFT_KEY = { key: 'Shift', code: 'ShiftLeft', vk: 16, location: 1 };
const ENTER = { key: 'Enter', code: 'Enter', vk: 13, text: '\r' };
const BACKSPACE = { key: 'Backspace', code: 'Backspace', vk: 8 };

// Physical key for a printable ASCII character, or null.
export function physicalKey(ch) {
  if (/^[a-z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), text: ch, shift: false };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}`, vk: ch.charCodeAt(0), text: ch, unmodified: ch.toLowerCase(), shift: true };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), text: ch, shift: false };
  if (PUNCT[ch]) return { key: ch, code: PUNCT[ch][0], vk: PUNCT[ch][1], text: ch, shift: false };
  if (SHIFTED_OF[ch]) {
    const base = physicalKey(SHIFTED_OF[ch]);
    return { ...base, key: ch, text: ch, unmodified: base.text, shift: true };
  }
  return null;
}

const down = (k, modifiers) => ({
  type: k.text ? 'keyDown' : 'rawKeyDown',
  modifiers,
  key: k.key,
  code: k.code,
  windowsVirtualKeyCode: k.vk,
  ...(k.text && { text: k.text, unmodifiedText: k.unmodified ?? k.text }),
  ...(k.location && { location: k.location }),
});
const up = (k, modifiers) => ({
  type: 'keyUp',
  modifiers,
  key: k.key,
  code: k.code,
  windowsVirtualKeyCode: k.vk,
  ...(k.location && { location: k.location }),
});

function press(k, shift) {
  if (!shift) return { downs: [down(k, 0)], ups: [up(k, 0)] };
  return {
    downs: [down(SHIFT_KEY, SHIFT_MOD), down(k, SHIFT_MOD)],
    ups: [up(k, SHIFT_MOD), up(SHIFT_KEY, 0)],
  };
}

// How to produce one planned op. Returns { downs, ups } for key presses
// (send downs, hold, send ups) or { insertText } for characters with no key.
export function strokeFor(op, newline = 'enter') {
  if (op.type === 'backspace') return press(BACKSPACE, false);
  const ch = op.char;
  if (ch === '\n') return press(ENTER, newline === 'shift_enter');
  const k = physicalKey(ch);
  return k ? press(k, k.shift) : { insertText: ch };
}
