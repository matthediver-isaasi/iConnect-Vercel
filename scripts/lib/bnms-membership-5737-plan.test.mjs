import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture as currentFixture } from './bnms-membership-5734-plan.test.mjs';
import { buildPlan as currentPlan } from './bnms-membership-5734-plan.mjs';
import { buildPlan, INVOICE, assertRecord } from './bnms-membership-5737-plan.mjs';
function fixture() {
  const e = currentFixture();
  const nullable = ['annual_cost', 'final_cost', 'total_with_vat', 'vat_amount', 'paid_at',
    'renewal_policy_snapshot', 'billing_agreement_id', 'membership_payment_quote_id',
    'membership_successor_election_id', 'term_key'];
  Object.assign(e.member_membership_history[0], Object.fromEntries(nullable.map(k => [k, null])));
  const c = currentPlan(e).record;
  e.member_membership_history.push({ ...c, ...Object.fromEntries(nullable.filter(k => !(k in c)).map(k => [k, null])) });
  const payment = { PaymentID: '3d8d9ed1-67fc-4c86-90b0-49e2bafa137f', Invoice: { InvoiceID: INVOICE },
    Status: 'AUTHORISED', Amount: 156, Date: '/Date(1757116800000+0000)/' };
  e.olderInvoice = { ...structuredClone(e.invoices[0]), InvoiceID: INVOICE, InvoiceNumber: '300004583',
    DateString: '2025-09-06T00:00:00', SubTotal: 156, Payments: [payment] };
  e.olderDetail = structuredClone(e.olderInvoice);
  e.invoices.push(e.olderInvoice);
  e.olderPayments = [payment]; e.olderPdfBytes = 100; e.allocations = [];
  e.historical_member_invoice.push({ invoice_number: '300004583', xero_document_id: INVOICE,
    amount_minor: 15600, xero_company_id: '3d57dce6-2205-462f-abf6-9c7cbf00be23' });
  return e;
}
test('repairs existing row, preserves provenance, current history and future policy; replay is identical', () => {
  const e = fixture(), before = structuredClone(e);
  const p = buildPlan(e);
  assert.equal(p.record.id, e.member_membership_history[0].id);
  assert.equal(p.record.term_start_date, '2025-10-06');
  assert.equal(p.record.term_end_date, '2026-10-05');
  assert.equal(p.record.paid_at, '2025-09-06T00:00:00.000Z');
  assert.equal(JSON.parse(p.record.notes).originalNotes, p.original.notes);
  assert.equal(p.record.renewal_policy_snapshot, null);
  assert.equal(p.record.commitment_snapshot.future_collection_consent, false);
  assert.ok(!Object.keys(p.record.commitment_snapshot.config).some(k => /^(renewal_|dd_)/.test(k)));
  assert.deepEqual(e, before);
  e.member_membership_history[0] = p.record;
  assertRecord(buildPlan(e, p.original).record, p.record);
});
for (const [label, mutate] of [
  ['identity', e => e.contact.AccountNumber = 'wrong'],
  ['dates', e => e.member_membership_history[0].term_end_date = '2026-11-05'],
  ['mapping', e => e.configs[0].id = 'wrong'],
  ['settlement', e => e.olderInvoice.AmountPaid = 0],
  ['detail conflict', e => e.olderDetail.Total = 200],
  ['payment identity', e => e.olderPayments[0].Invoice.InvoiceID = 'wrong'],
  ['payment date', e => e.olderPayments[0].Date = '/Date(0)/'],
  ['allocation', e => e.allocations.push({ id: 'other' })],
  ['current term changed', e => e.member_membership_history[1].term_start_date = '2026-10-07'],
  ['duplicate history', e => e.member_membership_history.push(e.member_membership_history[0])],
  ['competing annual invoice', e => e.invoices.push({ DateString: '2025-12-01' })],
]) test(`rejects ${label}`, () => { const e = fixture(); mutate(e); assert.throws(() => buildPlan(e)); });
