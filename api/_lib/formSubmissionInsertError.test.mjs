import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceOrderInsertFailure } from './formSubmissionInsertError.js';

test('invoice immutability failure is not reported as unavailable stock', () => {
  const failure = invoiceOrderInsertFailure({ code: 'P0001', message: 'Accepted invoice order is immutable' });
  assert.equal(failure.status, 409);
  assert.equal(failure.body.code, 'INVOICE_ORDER_VALIDATION_FAILED');
  assert.doesNotMatch(failure.body.error, /immutable|unavailable|stock/i);
});
test('stock and unrelated failures retain their existing handling', () => {
  for (const error of [null, { code: 'P0001', message: 'Cart item has insufficient stock' },
    { code: '40001', message: 'Cart payment terms changed' }, { code: '23505' }]) {
    assert.equal(invoiceOrderInsertFailure(error), null);
  }
});
