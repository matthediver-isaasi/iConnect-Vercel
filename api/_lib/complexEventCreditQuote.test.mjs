import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ComplexEventCreditQuoteError,
  assertCreditRoleAllowed,
  buildComplexEventCreditBinding,
  calculateComplexEventCreditQuote,
  normalizeRequestedVoucherIds,
} from './complexEventCreditQuote.js';

test('calculates exact independent and combined credit balances in minor units', () => {
  const base = {
    totalMinor: 10000,
    trainingFundBalance: 100,
    vouchers: [{ id: 'voucher-a', value: 25, expires_at: '2027-01-01' }],
  };
  assert.equal(calculateComplexEventCreditQuote(base).remainingMinor, 10000);
  assert.equal(calculateComplexEventCreditQuote({
    ...base, requestedVoucherIds: ['voucher-a'],
  }).remainingMinor, 7500);
  assert.equal(calculateComplexEventCreditQuote({
    ...base, requestedTrainingFundAmount: 30,
  }).remainingMinor, 7000);
  assert.deepEqual(calculateComplexEventCreditQuote({
    ...base,
    requestedVoucherIds: ['voucher-a'],
    requestedTrainingFundAmount: 30,
  }), {
    totalMinor: 10000,
    trainingFundMinor: 3000,
    voucherMinor: 2500,
    voucherDeductions: [{ voucherId: 'voucher-a', amountMinor: 2500 }],
    remainingMinor: 4500,
  });
});

test('rejects unavailable, duplicate, malformed, and overdrawn credits', () => {
  assert.throws(() => normalizeRequestedVoucherIds('voucher-a'), /must be an array/);
  assert.throws(() => normalizeRequestedVoucherIds(['voucher-a', 'voucher-a']), /more than once/);
  assert.throws(() => calculateComplexEventCreditQuote({
    totalMinor: 10000,
    requestedVoucherIds: ['missing'],
  }), /invalid or unavailable/);
  assert.throws(() => calculateComplexEventCreditQuote({
    totalMinor: 10000,
    requestedTrainingFundAmount: 31,
    trainingFundBalance: 30,
  }), /Insufficient training fund/);
});

test('enforces configured organization role restrictions', () => {
  assert.doesNotThrow(() => assertCreditRoleAllowed([], null, 'credits'));
  assert.doesNotThrow(() => assertCreditRoleAllowed(['role-a'], 'role-a', 'credits'));
  assert.throws(
    () => assertCreditRoleAllowed(['role-a'], 'role-b', 'credits'),
    (error) => error instanceof ComplexEventCreditQuoteError && error.statusCode === 403,
  );
});

test('credit binding is stable but changes with purchaser or original allocations', () => {
  const input = {
    eventId: 'event-a',
    memberId: 'member-a',
    organizationId: 'org-a',
    requestedTrainingFundAmount: 30,
    requestedVoucherIds: ['voucher-b', 'voucher-a'],
  };
  const binding = buildComplexEventCreditBinding(input);
  assert.equal(binding.length, 64);
  assert.equal(binding, buildComplexEventCreditBinding({
    ...input,
    requestedVoucherIds: ['voucher-a', 'voucher-b'],
  }));
  assert.notEqual(binding, buildComplexEventCreditBinding({
    ...input,
    memberId: 'member-b',
  }));
  assert.notEqual(binding, buildComplexEventCreditBinding({
    ...input,
    requestedTrainingFundAmount: 29,
  }));
});