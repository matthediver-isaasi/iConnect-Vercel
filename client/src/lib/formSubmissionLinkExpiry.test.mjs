import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidLinkExpiry, normalizeLinkExpiry } from './formSubmissionLinkExpiry.js';

test('accepts only decimal integers within the inclusive expiry bounds', () => {
  for (const value of ['1', '7', '28', '365', '007']) {
    assert.equal(isValidLinkExpiry(value), true, value);
  }
  for (const value of ['', ' ', '0', '-1', '366', '1.5', '7.0', '1e2', 'Infinity', 'NaN', ' 7 ', null, undefined]) {
    assert.equal(isValidLinkExpiry(value), false, String(value));
  }
});

test('defaults missing or invalid stored settings to seven days and normalizes decimal strings', () => {
  for (const value of [undefined, null, '', '0', '366', 'garbage']) {
    assert.equal(normalizeLinkExpiry(value), '7');
  }
  assert.equal(normalizeLinkExpiry('0012'), '12');
  assert.equal(normalizeLinkExpiry('365'), '365');
});
