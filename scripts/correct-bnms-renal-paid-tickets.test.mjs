import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentDate, paymentReplacement } from './correct-bnms-renal-paid-tickets.mjs';

const fixture = () => ({
  PaymentID: 'old-payment', Invoice: { InvoiceID: 'invoice' }, Status: 'AUTHORISED',
  PaymentType: 'ACCRECPAYMENT', IsReconciled: false, Amount: 120, BankAmount: 120,
  CurrencyRate: 1, Account: { CurrencyCode: 'GBP', AccountID: 'original-account' },
  Date: '/Date(1793923200000+0000)/', Reference: 'original-reference',
});
test('re-recording preserves the original amount, date, account and reference', () => {
  assert.deepEqual(paymentReplacement(fixture(), 'invoice', 'old-payment'), {
    Invoice: { InvoiceID: 'invoice' }, Account: { AccountID: 'original-account' },
    Date: '2026-11-06', Amount: 120, BankAmount: 120, Reference: 'original-reference',
    IsReconciled: false,
  });
});
test('rejects reconciled, batch, mismatched, reversed or changed payments', () => {
  for (const changed of [
    { IsReconciled: true }, { BatchPayment: {} }, { BatchPaymentID: 'batch' },
    { PaymentID: 'different' }, { Invoice: { InvoiceID: 'different' } },
    { Status: 'DELETED' }, { Amount: 119 }, { BankAmount: 119 },
    { CurrencyRate: 2 }, { Account: { CurrencyCode: 'USD', AccountID: 'bank' } },
    { PaymentType: 'APCREDITPAYMENT' },
  ]) assert.throws(() => paymentReplacement({ ...fixture(), ...changed }, 'invoice', 'old-payment'));
});
test('dates must use the reviewed provider format', () => {
  assert.equal(paymentDate('/Date(1793577600000+0000)/'), '2026-11-02');
  assert.throws(() => paymentDate('unknown'));
});
