import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDescriptionRepair, verifyDescriptionRepair } from './repair-bnms-invoice-9382.mjs';
import { recoveryIdentity } from '../api/_lib/eventInvoiceRecovery.js';
import { recoveryInvoiceMarker } from '../api/_lib/eventInvoiceRecoveryXero.js';

const sample = () => ({
  InvoiceID: '49bf0e7b-1575-4532-82ed-7a99adf85770', InvoiceNumber: 'INV-9382',
  Type: 'ACCREC', Status: 'AUTHORISED', CurrencyCode: 'GBP', Total: 200,
  SubTotal: 166.67, TotalTax: 33.33, AmountPaid: 0, AmountDue: 200,
  Contact: { ContactID: 'contact' }, Payments: [], LineAmountTypes: 'Inclusive',
  LineItems: [{ LineItemID: 'line', Description: 'Event and booker details'
    + recoveryInvoiceMarker(recoveryIdentity('ff2df806-b321-4254-b651-3af11fccf1db',
      'booking', 'OOE-1793016982039-C6JCW')),
  Quantity: 1, UnitAmount: 200, LineAmount: 166.67, TaxAmount: 33.33, TaxType: 'OUTPUT2',
  AccountCode: '200', Tracking: [] }],
});
test('exact repair changes only technical suffix and preserves all existing line IDs/finances', () => {
  const before = sample();
  before.LineItems.push({ LineItemID: 'second', Description: 'Unchanged second line', Quantity: 1, UnitAmount: 0 });
  const repair = buildDescriptionRepair(before);
  assert.equal(repair.LineItems[0].Description,
    'Event and booker details\nBooking reference: OOE-1793016982039-C6JCW');
  assert.deepEqual(repair.LineItems[1], before.LineItems[1]);
  verifyDescriptionRepair(before, { ...before, LineItems: repair.LineItems }, repair);
});
test('wrong invoice, marker and missing line ID stop before writes', () => {
  for (const modify of [
    i => { i.InvoiceID = 'other'; },
    i => { i.InvoiceNumber = 'INV-OTHER'; },
    i => { i.LineItems[0].Description += ' extra'; },
    i => { delete i.LineItems[0].LineItemID; },
  ]) {
    const invoice = sample(); modify(invoice);
    assert.throws(() => buildDescriptionRepair(invoice));
  }
});
test('postflight rejects amount, payment, contact, status and unrelated description changes', () => {
  const before = sample(), repair = buildDescriptionRepair(before);
  for (const modify of [
    i => { i.Total = 240; }, i => { i.AmountPaid = 200; },
    i => { i.Payments = [{ PaymentID: 'unexpected', Amount: 200 }]; },
    i => { i.Contact.ContactID = 'other'; }, i => { i.Status = 'VOIDED'; },
    i => { i.LineItems[0].TaxType = 'NONE'; },
  ]) {
    const after = structuredClone({ ...before, LineItems: repair.LineItems });
    modify(after);
    assert.throws(() => verifyDescriptionRepair(before, after, repair));
  }
});
