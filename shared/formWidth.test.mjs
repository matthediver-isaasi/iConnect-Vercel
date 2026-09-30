import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getFormMaxWidth,
  isValidFormWidth,
  normalizeFormWidth,
} from './formWidth.js';

test('form width presets validate and resolve their max widths', () => {
  assert.deepEqual(
    ['narrow', 'medium', 'wide'].map((value) => [
      value,
      isValidFormWidth(value),
      normalizeFormWidth(value),
      getFormMaxWidth(value),
    ]),
    [
      ['narrow', true, 'narrow', '48rem'],
      ['medium', true, 'medium', '64rem'],
      ['wide', true, 'wide', '80rem'],
    ],
  );
});

test('missing and invalid form widths retain the legacy narrow presentation', () => {
  for (const value of [undefined, null, '', 'NARROW', 'full', 64, {}, []]) {
    assert.equal(isValidFormWidth(value), false);
    assert.equal(normalizeFormWidth(value), 'narrow');
    assert.equal(getFormMaxWidth(value), '48rem');
  }
});