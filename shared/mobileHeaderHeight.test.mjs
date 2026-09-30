import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MOBILE_HEADER_HEIGHT_ERROR,
  resolveMobileHeaderHeight,
  validateMobileHeaderHeight,
} from './mobileHeaderHeight.js';

test('validates and normalizes configured mobile header heights', () => {
  assert.deepEqual(validateMobileHeaderHeight('64'), { ok: true, value: 64 });
  assert.deepEqual(validateMobileHeaderHeight(200), { ok: true, value: 200 });
  assert.deepEqual(validateMobileHeaderHeight(''), { ok: true, value: null });
  assert.deepEqual(validateMobileHeaderHeight(null), { ok: true, value: null });
});

test('rejects non-whole and out-of-range mobile header heights', () => {
  for (const value of [63, 201, 80.5, '80.5', 'not-a-number']) {
    assert.deepEqual(validateMobileHeaderHeight(value), {
      ok: false,
      error: MOBILE_HEADER_HEIGHT_ERROR,
    });
  }
});

test('resolves missing or invalid values to the 64px default', () => {
  assert.equal(resolveMobileHeaderHeight(undefined), 64);
  assert.equal(resolveMobileHeaderHeight(''), 64);
  assert.equal(resolveMobileHeaderHeight(90), 90);
  assert.equal(resolveMobileHeaderHeight(300), 64);
});