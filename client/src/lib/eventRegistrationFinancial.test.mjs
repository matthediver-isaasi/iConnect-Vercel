import assert from 'node:assert/strict';
import test from 'node:test';
import {
  financialAmount, financialCurrency, financialExport, paymentMethodLabel,
} from './eventRegistrationFinancial.js';

test('payment labels are based on explicit intention, not cost or guest/member status', () => {
  for (const [method, label] of [
    ['admin_import', 'Imported (financial history unavailable)'],
    ['free', 'Free'],
    ['card', 'Stripe'],
    ['account', 'Account'],
    ['account_balance', 'Account Balance'],
    ['invoice', 'Invoice'],
    ['public_invoice_po', 'Invoice / PO'],
    ['voucher', 'Voucher'],
    ['training_fund', 'Training Fund'],
    [null, 'Unknown'],
    ['unexpected', 'Unknown'],
  ]) {
    assert.equal(paymentMethodLabel(method), label);
  }
});

test('canonical missing financial amounts never become zero in display or CSV', () => {
  for (const value of [null, undefined, '', 'not a number']) {
    assert.equal(financialAmount(value), null);
    assert.equal(financialExport(value), 'Unavailable');
    assert.equal(financialCurrency(value), 'Unavailable');
  }
  assert.equal(financialAmount(0), 0);
  assert.equal(financialExport(0), '0.00');
  assert.equal(financialCurrency(0), '£0.00');
});