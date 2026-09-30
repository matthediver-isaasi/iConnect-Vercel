import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveEventPaymentPolicy,
  isEventPaymentPolicyKey,
} from './eventPaymentPolicy.js';

test('event payment methods remain enabled when settings are absent', () => {
  assert.deepEqual(resolveEventPaymentPolicy([]), {
    allowVoucherPayment: true,
    allowTrainingFundPayment: true,
  });
});

test('only explicit boolean or string false disables event payment methods', () => {
  assert.deepEqual(resolveEventPaymentPolicy([
    { setting_key: 'event_allow_voucher_payment', setting_value: false },
    { setting_key: 'event_allow_training_fund_payment', setting_value: ' FALSE ' },
  ]), {
    allowVoucherPayment: false,
    allowTrainingFundPayment: false,
  });

  assert.deepEqual(resolveEventPaymentPolicy([
    { setting_key: 'event_allow_voucher_payment', setting_value: '0' },
    { setting_key: 'event_allow_training_fund_payment', setting_value: null },
  ]), {
    allowVoucherPayment: true,
    allowTrainingFundPayment: true,
  });
});

test('event payment policy keys are identified for admin write protection', () => {
  assert.equal(isEventPaymentPolicyKey('event_allow_voucher_payment'), true);
  assert.equal(isEventPaymentPolicyKey('event_allow_training_fund_payment'), true);
  assert.equal(isEventPaymentPolicyKey('unrelated_setting'), false);
});