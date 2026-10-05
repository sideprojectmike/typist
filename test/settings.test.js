import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, resolveSettings } from '../extension/engine/settings.js';

test('defaults when nothing is stored or overridden', () => {
  assert.deepEqual(resolveSettings(), { ...DEFAULTS });
});

test('stored settings beat defaults; request overrides beat stored', () => {
  const s = resolveSettings({ wpm: 45, mistake_rate: 0.05 }, { wpm: 90 });
  assert.equal(s.wpm, 90);
  assert.equal(s.mistake_rate, 0.05);
});

test('undefined overrides are ignored', () => {
  assert.equal(resolveSettings({ wpm: 45 }, { wpm: undefined, mode: undefined }).wpm, 45);
});

test('Claude cannot set typing behaviour per request', () => {
  for (const key of ['mistake_rate', 'mistakes_enabled', 'variation', 'detection_delay', 'correction_pause']) {
    assert.throws(() => resolveSettings({}, { [key]: DEFAULTS[key] }), /configured in the extension/);
  }
});

test('invalid values are rejected, not clamped', () => {
  for (const bad of [
    { wpm: 5 }, { wpm: '60' }, { mistake_rate: 0.5 }, { variation: -1 },
    { detection_delay: { min: 3, max: 1 } }, { detection_delay: { min: 0.5, max: 2 } },
    { correction_pause: { min: 100 } }, { mode: 'paste' }, { newline: 'cr' }, { mistakes_enabled: 1 },
  ]) {
    assert.throws(() => resolveSettings(bad), RangeError, JSON.stringify(bad));
  }
});
