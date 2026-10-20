import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRepair, invoiceInvariant } from './repair-bnms-invoice-8958.mjs';

const fixture = () => {
  const invoiceId = '114acb56-e37e-4d9b-ade0-9f98255002f3';
  const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
  const group = 'OOE-1790198918339-82WJL';
  return {
    booking: { tenant_id: tenant, booking_group_reference: group, xero_invoice_id: invoiceId,
      xero_invoice_number: 'INV-8958', payment_method: 'card', status: 'confirmed',
      stripe_payment_intent_id: 'pi_fixture', attendee_email: 'payer@example.test',
      attendee_first_name: 'Tejas', attendee_last_name: 'Ingle', event_id: 'event-fixture',
      ticket_class_name: 'Member ticket', guest_organisation_name: 'Test hospital' },
    recovery: { tenant_id: tenant, id: '8126f3a8-fd0d-4b6d-95ee-adda6af98ad9',
      booking_group_reference: group, invoice_id: invoiceId, invoice_number: 'INV-8958',
      status: 'complete', settlement_payment_intent_id: 'pi_fixture',
      snapshot: { settlement: { livemode: true, captured: true, paymentIntentId: 'pi_fixture' },
        contact: { email: 'payer@example.test', provenance: { kind: 'historical_guest_verified_stripe_payer' } } } },
    invoice: { InvoiceID: invoiceId, InvoiceNumber: 'INV-8958', Type: 'ACCREC', Status: 'AUTHORISED',
      CurrencyCode: 'GBP', Total: 200, SubTotal: 166.67, TotalTax: 33.33, AmountPaid: 166.67,
      AmountDue: 33.33, LineAmountTypes: 'Exclusive', Contact: { ContactID: 'contact-fixture' },
      Payments: [{ PaymentID: '0c22c60b-56c5-4a68-a952-a493bd9cf9f5', Amount: 166.67 }],
      LineItems: [{ LineItemID: 'line', Description: 'Existing accountant description',
        Quantity: 1, UnitAmount: 166.67, TaxAmount: 33.33, TaxType: 'OUTPUT2', Tracking: [{ Option: 'Project' }] }] },
    contact: { ContactID: 'contact-fixture', Name: 'payer@example.test', EmailAddress: 'payer@example.test' },
    event: { id: 'event-fixture', tenant_id: tenant, name: 'Test congress' },
  };
};
test('repair changes customer identity and descriptive details only; retains accountant description', () => {
  const before = fixture();
  const plan = buildRepair(before);
  assert.equal(plan.contact.Name, 'Tejas Ingle (payer@example.test)');
  assert.equal(plan.contact.ContactID, before.contact.ContactID);
  assert.ok(plan.invoice.LineItems[0].Description.startsWith('Existing accountant description\n'));
  assert.match(plan.invoice.LineItems[0].Description, /Attendee organisation: Test hospital/);
  assert.deepEqual(invoiceInvariant(before.invoice),
    invoiceInvariant({ ...before.invoice, ...plan.invoice }));
  assert.equal('Addresses' in plan.contact, false);
});
test('repair refuses changed money, unrelated payer, different invoice, active lease, test settlement', () => {
  for (const mutate of [
    e => e.invoice.Total = 201,
    e => e.booking.attendee_email = 'other@example.test',
    e => e.invoice.InvoiceID = 'other',
    e => e.recovery.lease_token = 'busy',
    e => e.recovery.snapshot.settlement.livemode = false,
    e => e.contact.Name = 'Other customer',
  ]) {
    const evidence = fixture(); mutate(evidence);
    assert.throws(() => buildRepair(evidence));
  }
});
test('postflight invariant detects monetary, tax, tracking, payment and contact-ID changes', () => {
  for (const mutate of [
    i => i.AmountDue = 0,
    i => i.LineItems[0].TaxAmount = 0,
    i => i.LineItems[0].Tracking = [],
    i => i.Payments = [],
    i => i.Contact.ContactID = 'other',
  ]) {
    const a = fixture().invoice, b = structuredClone(a); mutate(b);
    assert.notDeepEqual(invoiceInvariant(a), invoiceInvariant(b));
  }
});
