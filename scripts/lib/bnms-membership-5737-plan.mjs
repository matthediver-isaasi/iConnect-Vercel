import assert from 'node:assert/strict';
import { buildPlan as currentPlan, assertRecord, ORIGINAL, TARGET, RELATED, CONFIG } from './bnms-membership-5734-plan.mjs';
import { buildRollingCommitment } from '../../api/_lib/rollingMembershipCommitment.js';
export { ORIGINAL, TARGET, RELATED, assertRecord };
export const INVOICE = 'e08f054b-bde5-4747-813a-303c57cb4f9c';
export function buildPlan(e, beforeImage) {
  const older = e.member_membership_history.find(h => h.id === ORIGINAL);
  const original = beforeImage || older;
  assert.equal(e.member_membership_history.length, 2);
  const baseline = structuredClone(e);
  baseline.member_membership_history = baseline.member_membership_history.map(h => h.id === ORIGINAL ? original : h);
  const approved = currentPlan(baseline);
  const current = e.member_membership_history.find(h => h.id === TARGET);
  assertRecord(current, approved.record);
  for (const key of ['annual_cost', 'final_cost', 'total_with_vat', 'vat_amount', 'paid_at',
    'renewal_policy_snapshot', 'billing_agreement_id', 'membership_payment_quote_id',
    'membership_successor_election_id', 'term_key']) assert.equal(original[key], null, key);
  assert.ok(e.allocations.every(h => h.id === ORIGINAL), 'Competing invoice allocation');
  const invoice = e.olderInvoice;
  assert.equal(e.invoices.filter(i => i.InvoiceNumber === '300004583').length, 1);
  assert.deepEqual(invoice, e.invoices.find(i => i.InvoiceNumber === '300004583'));
  for (const i of [invoice, e.olderDetail]) {
    for (const [k, v] of Object.entries({ InvoiceID: INVOICE, InvoiceNumber: '300004583',
      Type: 'ACCREC', Status: 'PAID', CurrencyCode: 'GBP', Total: 156, SubTotal: 156,
      AmountPaid: 156, AmountDue: 0, TotalTax: 0 })) assert.equal(i[k], v, k);
    assert.equal(i.Contact.ContactID, e.contact.ContactID);
    assert.equal(i.DateString.slice(0, 10), '2025-09-06');
    assert.equal(i.AmountCredited || 0, 0);
    assert.equal(i.CreditNotes?.length || 0, 0);
    assert.equal(i.LineItems.length, 1);
    assert.equal(i.LineItems[0].Description, 'Full Membership Overseas');
    assert.equal(i.LineItems[0].LineAmount, 156);
    assert.equal(i.LineItems[0].TaxAmount, 0);
  }
  assert.equal(invoice.Payments.length, 1);
  assert.equal(e.olderPayments.length, 1);
  const p = e.olderPayments[0];
  assert.equal(p.PaymentID, '3d8d9ed1-67fc-4c86-90b0-49e2bafa137f');
  assert.equal(p.PaymentID, invoice.Payments[0].PaymentID);
  assert.equal(p.Invoice.InvoiceID, INVOICE);
  assert.equal(p.Status, 'AUTHORISED');
  assert.equal(p.Amount, 156);
  const paidAt = new Date(Number(/\/Date\((\d+)/.exec(p.Date)?.[1])).toISOString();
  assert.equal(paidAt, '2025-09-06T00:00:00.000Z');
  assert.ok(e.olderPdfBytes > 5);
  assert.equal(e.invoices.filter(i => i.DateString.slice(0, 4) === '2025').length, 1,
    'Competing invoice in approved historical cycle');
  assert.ok(e.historical_member_invoice.some(i => i.invoice_number === '300004583'
    && i.xero_document_id === INVOICE && i.amount_minor === 15600
    && i.xero_company_id === '3d57dce6-2205-462f-abf6-9c7cbf00be23'));
  const amounts = { annual_cost: 156, final_cost: 156, total_with_vat: 156, vat_amount: 0, currency: 'GBP' };
  const commitment = buildRollingCommitment({ config: approved.record.commitment_snapshot.config,
    startDate: '2025-10-06', paymentMethod: 'upfront', paymentFrequency: 'upfront',
    amounts, pricingSnapshot: { tier_label: 'Overseas Full', ...amounts } });
  assert.equal(commitment.term_end_date, '2026-10-05');
  assert.equal(commitment.membership_renewal_date, current.term_start_date);
  Object.assign(commitment.commitment_snapshot, {
    source: 'administrator_approved_historical_reconstruction',
    structure_name: e.configs[0].name, future_collection_consent: false,
    structure_authority: 'current_member_class_mapping_not_original_2025_purchase_configuration',
  });
  const record = { ...original, ...commitment, ...amounts, config_id: CONFIG,
    membership_year: commitment.term_key, tier_label: 'Overseas Full', field_value: 'Overseas Full',
    paid_at: paidAt, accounting_provider: 'xero', accounting_invoice_id: INVOICE,
    accounting_invoice_number: '300004583', xero_invoice_id: INVOICE, xero_invoice_number: '300004583',
    notes: JSON.stringify({ source: 'bnms_owner_approved_older_term_reconstruction', version: 1,
      originalNotes: original.notes, originalProvenance: JSON.parse(original.notes),
      approval: { date: '2026-11-23', start: '2025-10-06', end: '2026-10-05' },
      termAuthority: 'explicit_owner_requested_coverage_not_invoice_issue_date',
      structureAuthority: 'administrator_current_class_reconstruction_not_original_2025_configuration',
      financialAuthority: 'independently_verified_xero_authorised_payment',
      invoiceId: INVOICE, paymentId: p.PaymentID, invoiceDate: '2025-09-06',
      futurePolicyAuthority: 'unassigned', futureCollectionConsent: false,
      preservedCurrentHistoryId: TARGET }),
  };
  // Preserve immutable import identity and all unrelated columns, including timestamps.
  return { original, current, record };
}
