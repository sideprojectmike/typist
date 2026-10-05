import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnose, expectedText, insertedAt, normalize } from '../extension/verify.js';

const state = (before = '', after = '') => ({ before, after });

test('exact match, allowing only CRLF and nbsp differences', () => {
  assert.deepEqual(diagnose('a b\r\nc', 'a b\nc', state()), { ok: true });
  assert.notDeepEqual(diagnose('a b', 'a  b', state()), { ok: true });
  assert.equal(normalize('x\ry'), 'x\ny');
});

test('repair backspaces to the first difference and retypes', () => {
  assert.deepEqual(diagnose('The quock', 'The quick', state()).repair, { keep: 'The qu', backspaces: 3, retype: 'ick' });
  assert.deepEqual(diagnose('Hello wor', 'hello wor', state()).repair, { keep: '', backspaces: 9, retype: 'hello wor' });
  assert.deepEqual(diagnose('abc', 'abcde', state()).repair, { keep: 'abc', backspaces: 0, retype: 'de' });
  assert.deepEqual(diagnose('abcxyz', 'abc', state()).repair, { keep: 'abc', backspaces: 3, retype: '' });
});

test('repair works between text before and after the caret', () => {
  const s = state('Dear ', ' regards');
  assert.deepEqual(diagnose('Dear Bob kind regards', expectedText(s, 'Rob kind'), s).repair, { keep: 'Dear ', backspaces: 8, retype: 'Rob kind' });
});

test('never deletes text that was already there', () => {
  const s = state('it\'s ', '');
  assert.match(diagnose('it’s fine', 'it\'s fine', s).fail, /already in the field/);
  assert.match(diagnose('Dear Bob', 'Dear Bob!', state('', ' tail')).fail, /after the caret/);
});

test('backspace count is in graphemes, never splitting an emoji', () => {
  assert.deepEqual(diagnose('a👍🏽x', 'a👍🏽y', state()).repair, { keep: 'a👍🏽', backspaces: 1, retype: 'y' });
  // Diverging inside a grapheme (different skin tone) backs off to its start.
  assert.deepEqual(diagnose('a👍🏽', 'a👍🏿', state()).repair, { keep: 'a', backspaces: 1, retype: '👍🏿' });
});

test('insertedAt finds one contiguous insertion anywhere in a document', () => {
  assert.equal(insertedAt('Hello world', 'Hello big world', 'big '), 6);
  assert.equal(insertedAt('', 'abc', 'abc'), 0);
  assert.equal(insertedAt('aa', 'aaaa', 'aa'), 0);
  assert.equal(insertedAt('x\r\ny', 'x\nzy', 'z'), 2);
  assert.equal(insertedAt('Hello world', 'Hello “big” world', '"big" '), -1);
  assert.equal(insertedAt('Hello world', 'Hxello worldy', 'xy'), -1);
});
