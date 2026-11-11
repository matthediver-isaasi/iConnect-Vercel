import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCpdPoints } from './cpdPointDisplay.js';
test('combined CPD balances retain fractional precision without numeric coercion', () => {
  assert.equal(formatCpdPoints('199999999999999.123456','en-GB'),'199,999,999,999,999.123456');
  assert.equal(formatCpdPoints('-0.000001','en-GB'),'-0.000001');
  assert.equal(formatCpdPoints('0.000000','en-GB'),'0');
  assert.equal(formatCpdPoints('-1.250000','de-DE'),'-1,25');
});
