import test from 'node:test';
import assert from 'node:assert/strict';
import { APPROVED, checkInvoice, checkResult, checkUnused } from './apply-bnms-approved-invoice-renumber.mjs';
const fixture = () => ({ InvoiceID: APPROVED[0].id, InvoiceNumber: APPROVED[0].number,
  Type: 'ACCREC', Status: 'AUTHORISED', CurrencyCode: 'GBP',
  Total: 200, SubTotal: 166.67, TotalTax: 33.33, AmountPaid: 166.67, AmountDue: 33.33,
  Contact: { ContactID: 'offline-contact' }, LineItems: [{ LineItemID: 'offline-line' }],
  Payments: [{ PaymentID: 'offline-payment', Amount: 166.67 }] });
test('preserves actual partially paid financial state, not historical paid assumptions', () => {
  const before = fixture(), after = { ...before, InvoiceNumber: APPROVED[0].assigned, UpdatedDateUTC: 'new' };
  assert.doesNotThrow(() => checkResult(before, after, APPROVED[0]));
  for (const change of [{ Total: 166.67 }, { Status: 'PAID' }, { AmountDue: 0 },
    { Reference: 'new' }, { Payments: [] }, { Contact: { ContactID: 'changed' } }])
    assert.throws(() => checkResult(before, { ...after, ...change }, APPROVED[0]));
});
test('identity, exact duplicate query and both assigned numbers are pinned', () => {
  assert.deepEqual(APPROVED.map(t => t.assigned), ['INV-8956', 'INV-8957']);
  assert.throws(() => checkInvoice({ ...fixture(), InvoiceID: APPROVED[1].id }, APPROVED[0]));
  assert.doesNotThrow(() => checkUnused({ Invoices: [] }, 'INV-8956'));
  for (const body of [{}, { Invoices: [{ InvoiceNumber: 'INV-8956' }] },
    { Invoices: [{ InvoiceNumber: 'other' }] }]) assert.throws(() => checkUnused(body, 'INV-8956'));
});