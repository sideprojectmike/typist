// Typing behaviour lives in the extension. Claude may override only the
// fields in OVERRIDABLE; everything else comes from the user's stored settings.
export const DEFAULTS = Object.freeze({
  wpm: 60,
  variation: 0.35, // log-normal sigma for keystroke intervals
  mistakes_enabled: true,
  mistake_rate: 0.02, // chance of a mistake per character
  detection_delay: Object.freeze({ min: 0, max: 3 }), // extra chars typed before noticing
  correction_pause: Object.freeze({ min: 150, max: 500 }), // ms
  mode: 'insert', // 'insert' at caret | 'replace' field contents
  newline: 'enter', // 'enter' | 'shift_enter'
});

export const OVERRIDABLE = ['wpm', 'mode', 'newline'];

const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const isRange = (r, min, max, int) =>
  r && isNum(r.min, min, max) && isNum(r.max, min, max) && r.min <= r.max &&
  (!int || (Number.isInteger(r.min) && Number.isInteger(r.max)));

const RULES = {
  wpm: [(v) => isNum(v, 10, 200), 'a number from 10 to 200'],
  variation: [(v) => isNum(v, 0, 1), 'a number from 0 to 1'],
  mistakes_enabled: [(v) => typeof v === 'boolean', 'a boolean'],
  mistake_rate: [(v) => isNum(v, 0, 0.2), 'a number from 0 to 0.2'],
  detection_delay: [(v) => isRange(v, 0, 10, true), '{min, max} integers from 0 to 10, min <= max'],
  correction_pause: [(v) => isRange(v, 0, 5000, false), '{min, max} ms from 0 to 5000, min <= max'],
  mode: [(v) => v === 'insert' || v === 'replace', '"insert" or "replace"'],
  newline: [(v) => v === 'enter' || v === 'shift_enter', '"enter" or "shift_enter"'],
};

export function validateSettings(settings) {
  for (const [key, [ok, expected]] of Object.entries(RULES)) {
    if (!ok(settings[key])) throw new RangeError(`setting "${key}" must be ${expected}`);
  }
  return settings;
}

// stored: what the options page saved (already validated on save, but
// re-checked here so a corrupt store fails loudly instead of typing oddly).
// overrides: optional per-request values from Claude.
export function resolveSettings(stored = {}, overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (overrides[key] === undefined) continue;
    if (!OVERRIDABLE.includes(key)) {
      throw new RangeError(`"${key}" cannot be set per request; it is configured in the extension`);
    }
  }
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  return validateSettings({ ...DEFAULTS, ...stored, ...defined });
}
