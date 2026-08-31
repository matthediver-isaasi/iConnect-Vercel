import assert from 'node:assert/strict';
import test from 'node:test';
import { currencyFractionDigits, minorToMajor } from './salesMoney.js';

test('minor-unit conversion follows ISO currency fraction digits', () => {
  assert.equal(currencyFractionDigits('GBP'), 2);
  assert.equal(minorToMajor(12345, 'GBP'), 123.45);
  assert.equal(currencyFractionDigits('JPY'), 0);
  assert.equal(minorToMajor(12345, 'JPY'), 12345);
  assert.equal(currencyFractionDigits('BHD'), 3);
  assert.equal(minorToMajor(12345, 'BHD'), 12.345);
});