import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRecoveryInvoiceFinancials } from './eventInvoiceRecoveryXero.js';
import { simpleEventInvoiceLines, complexEventInvoiceLines } from './eventInvoiceProducer.js';

const snapshot = () => ({ currency: 'GBP', invoice: {
  Date: '2026-11-03', DueDate: '2026-12-03', LineAmountTypes: 'Inclusive',
  LineItems: [{ AccountCode: '4200', TaxType: 'EXEMPTOUTPUT', TaxAmount: 0,
    UnitAmount: 65, Quantity: 1, Description: 'Workshop',
    Tracking: [{ Name: 'Projects', Option: ' IPJW080427 ' }] }],
} });
const returned = () => {
  const s = snapshot();
  return { ...s.invoice, LineItems: [{ ...s.invoice.LineItems[0], LineAmount: 65,
    Tracking: [{ Name: ' Projects ', Option: 'IPJW080427' }] }] };
};
test('ignores outer tracking whitespace in issued invoice verification', () => {
  assert.equal(verifyRecoveryInvoiceFinancials(returned(), snapshot()), true);
});
test('retains exact case, internal spaces and financial evidence checks', () => {
  for (const change of [
    { Tracking: [{ Name: 'Projects', Option: 'IPJW 080427' }] },
    { Tracking: [{ Name: 'Projects', Option: 'ipjw080427' }] },
    { Tracking: [{ Name: 'Another category', Option: 'IPJW080427' }] },
    { Tracking: [] }, { TaxAmount: 1 }, { UnitAmount: 66 }, { AccountCode: 'other' },
    { Description: 'Different workshop' }, { Quantity: 2 },
  ]) {
    const invoice = returned();
    Object.assign(invoice.LineItems[0], change);
    assert.equal(verifyRecoveryInvoiceFinancials(invoice, snapshot()), false);
  }
});

test('new simple and complex event invoices trim tracking options without altering descriptions', () => {
  for (const code of [' IPJW080427 ', '   ']) {
    const event = { title: 'Workshop', internal_reference: code };
    const simple = simpleEventInvoiceLines({
      event, bookingAttendees: [], ticketsRequired: 1, ticketClassPrice: 65,
      totalCost: 65, validatedRemainingBalance: 65,
    }, '4200');
    const complex = complexEventInvoiceLines({
      event, resolvedItems: [{ serverTicket: { name: 'Ticket' }, authoritativePrice: 65,
        ticketClass: { vat_rate_key: 'EXEMPTOUTPUT', vat_rate_percentage: 0 },
        attendees: [{ first_name: 'Attendee' }] }],
      actualVoucherApplied: 0, actualTfApplied: 0,
    }, '4200');
    for (const line of [...simple, ...complex]) {
      assert.deepEqual(line.Tracking, code.trim() ? [{ Name: 'Projects', Option: 'IPJW080427' }] : undefined);
    }
    assert.ok(simple[0].Description.includes(`Reference: ${code}`));
  }
});
