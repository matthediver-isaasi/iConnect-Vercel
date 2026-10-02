import test from 'node:test';
import assert from 'node:assert/strict';
import { reconstructHistoricalEventInvoice, reconstructHistoricalEventInvoices } from './eventInvoiceReconstruction.js';
import { validRecoverySnapshot } from './eventInvoiceRecovery.js';

const input = () => ({
  candidate: { operationId: 'operation', tenantId: 'tenant', source: 'booking', bookingGroupReference: 'group' },
  bookings: [{ tenant_id: 'tenant', event_id: 'event', booking_group_reference: 'group', status: 'confirmed',
    payment_method: 'account', created_at: '2026-01-01T10:00:00Z', organization_id: 'buyer', member_id: 'booker',
    ticket_class_id: 'ticket', ticket_price: 200, total_cost: 200, account_amount: 200,
    attendee_email: 'not-the-buyer@example.test' }],
  event: { id: 'event', title: 'Original event', xero_account_code: '201' },
  tickets: [{ id: 'ticket', name: 'Early bird', price: 300, early_bird_price: 200,
    vat_rate_key: 'NONE', vat_rate_percentage: 0, currency: 'GBP' }],
  organization: { id: 'buyer', tenant_id: 'tenant', name: 'Purchaser organization' },
  providers: [{ id: 'connection', tenant_id: 'xero-org' }],
});

test('automatic original-row reconstruction preserves early bird amount and organization without attendee email', () => {
  const original = input(); const copy = structuredClone(original);
  const s = reconstructHistoricalEventInvoice(original);
  assert.equal(validRecoverySnapshot(s), true);
  assert.equal(s.amount, 200);
  assert.equal(s.invoice.Contact.Name, 'Purchaser organization');
  assert.equal(s.invoice.Contact.EmailAddress, undefined);
  assert.equal(s.invoice.LineItems[0].UnitAmount, 200);
  assert.equal(s.invoice.Date, '2026-01-01');
  assert.equal(s.invoice.DueDate, '2026-01-31');
  assert.equal(s.invoice.InvoiceNumber, undefined);
  assert.deepEqual(original, copy);
});

test('explicit Inclusive 20% ticket reconstructs booked gross 200 as net 166.67 plus VAT 33.33, never catalogue 300', () => {
  const original = input();
  Object.assign(original.tickets[0], {
    invoice_line_amount_type: 'Inclusive', vat_rate_key: 'OUTPUT2', vat_rate_percentage: 20,
  });
  const s = reconstructHistoricalEventInvoice(original);
  assert.equal(validRecoverySnapshot(s), true);
  assert.equal(s.amount, 200);
  assert.equal(s.invoice.LineAmountTypes, 'Inclusive');
  assert.equal(s.invoice.LineItems[0].UnitAmount, 200);
  assert.equal(s.invoice.LineItems[0].TaxAmount, 33.33);
  assert.equal(Number((s.amount - s.invoice.LineItems[0].TaxAmount).toFixed(2)), 166.67);
  assert.equal(s.reconstruction.ticketEvidence[0].invoice_line_amount_type, 'Inclusive');
});

for (const [label, change, reason] of [
  ['missing VAT', i => { i.tickets[0].vat_rate_key = null; i.tickets[0].vat_rate_percentage = null; }, 'tax_evidence_missing'],
  ['nonzero VAT without reconciled gross', i => { i.tickets[0].vat_rate_percentage = 20; }, 'tax_total_requires_review'],
  ['invalid amount policy', i => { i.tickets[0].invoice_line_amount_type = 'gross'; }, 'line_amount_policy_invalid'],
  ['inclusive without VAT rate', i => { i.tickets[0].invoice_line_amount_type = 'Inclusive'; i.tickets[0].vat_rate_percentage = null; }, 'tax_evidence_missing'],
  ['missing buyer', i => { i.organization = null; }, 'purchaser_missing'],
  ['missing currency', i => { delete i.tickets[0].currency; }, 'currency_missing'],
  ['missing account', i => { delete i.event.xero_account_code; }, 'sales_account_missing'],
  ['discount allocation', i => { i.bookings[0].voucher_amount = 10; }, 'credit_allocation_requires_review'],
  ['wrong amount', i => { i.bookings[0].account_amount = 199; }, 'amount_ambiguous'],
  ['Stripe without verified live evidence', i => { i.bookings[0].payment_method = 'card'; }, 'verified_live_settlement_required'],
  ['guest purchaser ambiguous', i => { i.bookings[0].is_guest_booking = true; }, 'purchaser_requires_review'],
]) test(`automatic reconstruction rejects ${label} with specific reason`, () => {
  const i = input(); change(i);
  assert.throws(() => reconstructHistoricalEventInvoice(i), { code: `historical_${reason}` });
});

test('automatic resolver persists snapshot through fenced authority, and persists specific blocked reason', async () => {
  const good = input(); const bad = input(); bad.tickets[0].vat_rate_key = null;
  const calls = [];
  const db = { rpc: async (name, args) => {
    calls.push([name, args]);
    return { data: name.endsWith('_automatic_candidates') ? [good, bad] : { status: 'approved' } };
  } };
  await reconstructHistoricalEventInvoices({ db, limit: 20, operationId: null, deadlineAt: Date.now() + 5000 });
  assert.equal(calls.length, 3);
  assert.equal(calls[1][0], 'event_invoice_recovery_automatic_commit');
  assert.equal(calls[1][1].p_snapshot.amount, 200);
  assert.equal(calls[2][1].p_snapshot, null);
  assert.equal(calls[2][1].p_reason, 'historical_tax_evidence_missing');
});