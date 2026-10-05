import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPlan, PlanError, replay } from '../extension/engine/buffer.js';
import { isSafe } from '../extension/engine/keyboard.js';
import { buildPlan } from '../extension/engine/planner.js';
import { createRng } from '../extension/engine/rng.js';
import { PROSE, randomText, settings, walk } from './helpers.js';

const plan = (text, over, seed = 1) => buildPlan(text, settings(over), createRng(seed));

test('final text is exact for thousands of random texts, seeds and settings', () => {
  for (let seed = 0; seed < 5000; seed++) {
    const rng = createRng(seed * 7919);
    const text = randomText(seed);
    const lo = rng.int(0, 4);
    const s = { mistake_rate: rng.float(0, 0.2), detection_delay: { min: lo, max: lo + rng.int(0, 4) } };
    const ops = plan(text, s, seed);
    assert.equal(replay(ops), text, `seed ${seed}`);
  }
});

test('no mistakes: one key per character, nothing else', () => {
  const text = 'Hello, how are you?\nFine 👍🏽';
  for (const over of [{ mistake_rate: 0 }, { mistakes_enabled: false, mistake_rate: 0.2 }]) {
    const keys = plan(text, over).filter((op) => op.type !== 'checkpoint');
    assert.deepEqual(keys.map((op) => op.char), Array.from(text));
  }
});

test('every mistake is visible on screen when it is noticed', () => {
  const kinds = new Set();
  for (let seed = 0; seed < 200; seed++) {
    const target = Array.from(PROSE);
    walk(plan(PROSE, { mistake_rate: 0.2 }, seed), (op, buf) => {
      if (op.type !== 'notice') return;
      kinds.add(op.kind);
      assert.notEqual(buf.join(''), target.slice(0, buf.length).join(''), `${op.kind} not visible, seed ${seed}`);
    });
  }
  assert.deepEqual([...kinds].sort(), ['capitalization', 'duplicate', 'omission', 'substitution', 'transposition']);
});

test('"The quock" style: a substitution is typed, corrected, and typing continues', () => {
  const text = 'The quick brown fox';
  for (let seed = 0; seed < 500; seed++) {
    const ops = plan(text, { mistake_rate: 0.2 }, seed);
    let seen = false;
    walk(ops, (op, buf) => {
      if (op.type === 'notice' && op.kind === 'substitution') seen = true;
    });
    if (!seen) continue;
    assert.equal(replay(ops), text);
    return;
  }
  assert.fail('no substitution found');
});

test('detection delay bounds how far typing runs past a mistake', () => {
  for (const delay of [{ min: 0, max: 0 }, { min: 0, max: 3 }, { min: 2, max: 5 }]) {
    for (let seed = 0; seed < 300; seed++) {
      const target = Array.from(PROSE);
      walk(plan(PROSE, { mistake_rate: 0.15, detection_delay: delay }, seed), (op, buf) => {
        if (op.type !== 'notice') return;
        let d = 0;
        while (buf[d] === target[d]) d++;
        // Wrong part is at most 2 characters (duplicate, transposition).
        assert.ok(buf.length - d <= 2 + delay.max, `ran ${buf.length - d} past, seed ${seed}`);
      });
    }
  }
});

test('zero detection delay means no omissions (they need a following character)', () => {
  for (let seed = 0; seed < 300; seed++) {
    const kinds = plan(PROSE, { mistake_rate: 0.2, detection_delay: { min: 0, max: 0 } }, seed)
      .filter((op) => op.type === 'notice').map((op) => op.kind);
    assert.ok(!kinds.includes('omission'));
  }
});

test('newlines, tabs and non-ASCII are only typed while the buffer is correct', () => {
  for (let seed = 0; seed < 2000; seed++) {
    const text = randomText(seed, 60);
    const target = Array.from(text);
    walk(plan(text, { mistake_rate: 0.2, detection_delay: { min: 0, max: 5 } }, seed), (op, buf) => {
      if (op.type === 'key' && !isSafe(op.char)) {
        assert.equal(buf.join(''), target.slice(0, buf.length).join(''), `seed ${seed}`);
      }
    });
  }
});

test('backspace only ever deletes printable ASCII', () => {
  for (let seed = 0; seed < 2000; seed++) {
    const text = randomText(seed, 60);
    const buf = [];
    for (const op of plan(text, { mistake_rate: 0.2 }, seed)) {
      if (op.type === 'key') buf.push(op.char);
      if (op.type === 'backspace') assert.ok(isSafe(buf.pop()), `seed ${seed}`);
    }
  }
});

test('checkpoints fall after each word and at the end', () => {
  const ats = plan('one two\nthree', { mistake_rate: 0 }).filter((op) => op.type === 'checkpoint').map((op) => op.at);
  assert.deepEqual(ats, [4, 8, 13]);
  assert.deepEqual(plan('', {}), [{ type: 'checkpoint', at: 0 }]);
});

test('same seed, same plan', () => {
  assert.deepEqual(plan(PROSE, { mistake_rate: 0.1 }, 42), plan(PROSE, { mistake_rate: 0.1 }, 42));
});

test('assertPlan rejects plans that end wrong or checkpoint on a dirty buffer', () => {
  const k = (char) => ({ type: 'key', char });
  assert.throws(() => assertPlan([k('a'), { type: 'checkpoint', at: 1 }], 'b'), PlanError);
  assert.throws(() => assertPlan([k('x'), { type: 'checkpoint', at: 1 }, { type: 'backspace' }, k('a'), { type: 'checkpoint', at: 1 }], 'a'), PlanError);
  assert.throws(() => assertPlan([{ type: 'backspace' }], ''), PlanError);
  assert.throws(() => assertPlan([k('a')], 'a'), PlanError); // missing final checkpoint
  assert.doesNotThrow(() => assertPlan([k('x'), { type: 'backspace' }, k('a'), { type: 'checkpoint', at: 1 }], 'a'));
});
