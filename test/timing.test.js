import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTypingPlan } from '../extension/engine/index.js';
import { msPerChar } from '../extension/engine/timing.js';
import { PROSE, settings } from './helpers.js';

const LONG = PROSE.repeat(6);
const wpmOf = (text, ms) => (Array.from(text).length / 5) / (ms / 60000);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

test('clean typing runs at the requested WPM (thinking pauses only slow it slightly)', () => {
  for (const wpm of [40, 60, 80, 100, 150]) {
    for (let seed = 0; seed < 20; seed++) {
      const { duration_ms } = createTypingPlan(LONG, settings({ wpm, mistake_rate: 0 }), seed);
      const ratio = wpmOf(LONG, duration_ms) / wpm;
      assert.ok(ratio > 0.88 && ratio < 1.05, `wanted ${wpm}, got ${(ratio * wpm).toFixed(1)}`);
    }
  }
});

test('mistakes cost real time instead of speeding up other keys', () => {
  const ordinaryKeyDelays = (rate) => {
    const delays = [];
    for (let seed = 0; seed < 30; seed++) {
      const { ops } = createTypingPlan(LONG, settings({ mistake_rate: rate }), seed);
      let inEpisode = false; // skip keys typed as part of a mistake or its correction
      for (const op of ops) {
        if (op.type === 'notice') inEpisode = true;
        else if (op.type === 'checkpoint') inEpisode = false;
        else if (op.type === 'key' && !inEpisode && op.delay < 1000) delays.push(op.delay);
      }
    }
    return mean(delays);
  };
  const clean = ordinaryKeyDelays(0);
  const messy = ordinaryKeyDelays(0.1);
  assert.ok(Math.abs(messy - clean) / clean < 0.05, `clean ${clean.toFixed(1)} vs with mistakes ${messy.toFixed(1)}`);

  const durations = (rate) => mean([...Array(30).keys()].map((seed) => createTypingPlan(LONG, settings({ mistake_rate: rate }), seed).duration_ms));
  assert.ok(durations(0.1) > durations(0) * 1.1, 'mistakes should make the job take longer');
});

test('delays vary between keystrokes', () => {
  const { ops } = createTypingPlan(LONG, settings({ mistake_rate: 0 }), 3);
  const delays = ops.filter((op) => op.type === 'key').map((op) => op.delay);
  assert.ok(new Set(delays).size > 50);
  assert.ok(Math.abs(mean(delays) - msPerChar(60)) / msPerChar(60) < 0.12);
});

test('correction pause stays inside the configured range', () => {
  const s = settings({ mistake_rate: 0.2, correction_pause: { min: 300, max: 400 } });
  const notices = createTypingPlan(LONG, s, 9).ops.filter((op) => op.type === 'notice');
  assert.ok(notices.length > 10);
  for (const op of notices) assert.ok(op.delay >= 300 && op.delay <= 400, `${op.delay}`);
});

test('delays and holds are whole ms; holds end before the next key', () => {
  const { ops } = createTypingPlan(LONG, settings({ mistake_rate: 0.1 }), 5);
  assert.equal(ops[0].delay, 0);
  ops.forEach((op, n) => {
    assert.ok(Number.isInteger(op.delay));
    if (op.type === 'checkpoint') return assert.equal(op.delay, 0);
    if (n > 0) assert.ok(op.delay >= 20);
    if (op.type === 'key' || op.type === 'backspace') {
      assert.ok(Number.isInteger(op.hold) && op.hold >= 5);
      const next = ops.slice(n + 1).find((o) => o.type !== 'checkpoint');
      if (next) assert.ok(op.hold <= Math.max(5, next.delay / 2 + 1), `hold ${op.hold} vs next ${next.delay}`);
    }
  });
});

test('plan reports its seed and stats, and is reproducible', () => {
  const a = createTypingPlan(PROSE, settings({ mistake_rate: 0.1 }), 77);
  assert.equal(a.seed, 77);
  assert.equal(a.stats.mistakes, a.ops.filter((op) => op.type === 'notice').length);
  assert.deepEqual(createTypingPlan(PROSE, settings({ mistake_rate: 0.1 }), 77), a);
  assert.equal(createTypingPlan('', settings(), 1).duration_ms, 0);
});
