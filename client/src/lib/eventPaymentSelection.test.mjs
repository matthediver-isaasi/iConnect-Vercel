import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEffectiveEventPaymentSelection,
  resolveSavedPaidEventPaymentSelection,
} from './eventPaymentSelection.mjs';

test('unresolved policy cannot leak stale voucher or training fund allocations', () => {
  assert.deepEqual(resolveEffectiveEventPaymentSelection({
    policy: null,
    selectedVoucherIds: ['voucher-1'],
    trainingFundAmount: 25,
  }), {
    voucherEnabled: false,
    trainingFundEnabled: false,
    selectedVoucherIds: [],
    trainingFundAmount: 0,
  });
});

test('payment methods are gated independently by policy and existing eligibility', () => {
  const policy = { allowVoucherPayment: true, allowTrainingFundPayment: false };
  assert.deepEqual(resolveEffectiveEventPaymentSelection({
    policy,
    selectedVoucherIds: ['voucher-1'],
    trainingFundAmount: 25,
  }), {
    voucherEnabled: true,
    trainingFundEnabled: false,
    selectedVoucherIds: ['voucher-1'],
    trainingFundAmount: 0,
  });

  assert.deepEqual(resolveEffectiveEventPaymentSelection({
    policy: { allowVoucherPayment: true, allowTrainingFundPayment: true },
    selectedVoucherIds: ['voucher-1'],
    trainingFundAmount: 25,
    voucherEligible: false,
    trainingFundEligible: false,
  }), {
    voucherEnabled: false,
    trainingFundEnabled: false,
    selectedVoucherIds: [],
    trainingFundAmount: 0,
  });
});

test('enabled selections retain voucher order and normalize training fund amounts', () => {
  const selection = resolveEffectiveEventPaymentSelection({
    policy: { allowVoucherPayment: true, allowTrainingFundPayment: true },
    selectedVoucherIds: ['voucher-2', 'voucher-1'],
    trainingFundAmount: '12.50',
  });
  assert.deepEqual(selection.selectedVoucherIds, ['voucher-2', 'voucher-1']);
  assert.equal(selection.trainingFundAmount, 12.5);
});

test('paid booking recovery retains the exact pre-intent credit snapshot', () => {
  assert.deepEqual(resolveSavedPaidEventPaymentSelection({
    selectedVoucherIds: ['voucher-1'],
    trainingFundAmount: 20,
    voucherOrderManual: true,
  }), {
    selectedVoucherIds: ['voucher-1'],
    voucherOrderManual: false,
    trainingFundAmount: 20,
  });

  assert.deepEqual(resolveSavedPaidEventPaymentSelection({
    selectedVoucherIds: ['voucher-2', 'voucher-1'],
    trainingFundAmount: '12.50',
    voucherOrderManual: true,
  }), {
    selectedVoucherIds: ['voucher-2', 'voucher-1'],
    voucherOrderManual: true,
    trainingFundAmount: 12.5,
  });
});