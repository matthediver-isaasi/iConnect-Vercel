import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildRollingCommitment } from '../api/_lib/rollingMembershipCommitment.js';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const REVIEW_HASH = '9a3cbd459d81fa1c946bc62a827f311109ab6c6e87eae48fd382ed3ec29e0810';
export const CSV_HASH = '5506d9eb76a21e3f43233a82fc050682bffa43a0584c1efe471632ee1d0a9070';
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function approvalState(before, records) {
  const ids = new Set(records.map(r => r.member_id));
  return { records,
    members: before.member.filter(r => ids.has(r.id)),
    preferences: before.member_preference_value.filter(r => ids.has(r.member_id)),
    histories: before.member_membership_history.filter(r => ids.has(r.member_id)),
  };
}
export const memberInvoice = i => (i.LineItems || []).some(l =>
  /\bmembership\b|\b(?:full|associate|trainee|student|retired|overseas|honorary|LMIC)[ -]+member\b/i.test(l.Description || ''));
export function historyId(memberId) {
  const h = sha(`${REVIEW_HASH}:${memberId}`);
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
export function financialProjection(i) {
  return Object.fromEntries(['InvoiceID','InvoiceNumber','Type','Status','CurrencyCode','DateString',
    'Total','TotalTax','AmountPaid','AmountDue','AmountCredited','LineItems','Payments','CreditNotes','Contact']
    .map(k => [k, k === 'Contact' ? i.Contact?.ContactID : i[k] ?? null]));
}
export function buildRecord(candidate, config, provider) {
  assert.equal(config.billing_period, 'annual');
  assert.equal(config.start_mode, 'immediate');
  assert.equal(config.structure_match_value, candidate.memberClass);
  const invoice = provider.membershipInvoices.find(i => i.InvoiceID === provider.latestPaidInvoiceId);
  assert.ok(invoice);
  const lines = invoice.LineItems.filter(l => /\bmembership\b/i.test(l.Description || '')
    && !/\bevent|attend|conference|meeting|ticket|party|dinner|bootcamp|discount/i.test(l.Description || ''));
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.equal(line.Quantity, 1);
  assert.equal(line.TaxAmount, 0);
  assert.equal(line.LineAmount, candidate.membershipAmount);
  assert.ok(line.LineAmount > 0);
  const amounts = { annual_cost: line.LineAmount, final_cost: line.LineAmount,
    vat_amount: 0, total_with_vat: line.LineAmount, currency: 'GBP' };
  const commitment = buildRollingCommitment({ config, startDate: candidate.proposedStart,
    paymentMethod: 'upfront', paymentFrequency: 'upfront', amounts,
    pricingSnapshot: { tier_label: candidate.memberClass, ...amounts,
      provenance: 'operator_approved_historical_reconstruction_not_original_quote' } });
  assert.equal(commitment.term_end_date, candidate.retainedExpiry);
  assert.equal(commitment.membership_renewal_date, candidate.proposedRenewal);
  const paymentDates = provider.payments.map(p => {
    const ms = /\/Date\((\d+)/.exec(p.Date)?.[1];
    assert.ok(ms);
    return Number(ms);
  });
  assert.ok(paymentDates.length);
  const provenance = {
    source: 'bnms_approved_72_xero_reconstruction', version: 1,
    reviewSha256: REVIEW_HASH, csvSha256: CSV_HASH, approvalDate: '2026-10-14',
    approval: 'Explicit approval of all 72 candidate members and exact dates in pinned CSV',
    termAuthority: 'operator_approved_12_month_term_ending_on_retained_expiry',
    structureAuthority: 'reviewed_current_member_class_mapping',
    historicalScheduleCaveat: 'Current structure mapping is not evidence of the structure or policies at original purchase.',
    paymentAuthority: 'xero_authorised_payments', invoiceId: invoice.InvoiceID,
    paymentIds: provider.payments.map(p => p.PaymentID).sort(),
    membershipLineId: line.LineItemID ?? null,
    historicalPaymentInstrument: 'unknown', originalQuoteAndConsent: 'unknown',
    futureCollectionConsent: false, providerWrites: 0,
  };
  return { id: historyId(candidate.memberId), tenant_id: TENANT, member_id: candidate.memberId,
    config_id: config.id, tier_label: candidate.memberClass, field_value: candidate.memberClass,
    membership_year: commitment.term_key, ...commitment, ...amounts,
    billing_period: 'annual', status: 'active', payment_status: 'paid', payment_method: 'upfront',
    paid_at: new Date(Math.max(...paymentDates)).toISOString(),
    accounting_provider: 'xero', accounting_invoice_id: invoice.InvoiceID,
    accounting_invoice_number: invoice.InvoiceNumber, xero_invoice_id: invoice.InvoiceID,
    xero_invoice_number: invoice.InvoiceNumber, accounting_sync_status: null,
    notes: JSON.stringify(provenance) };
}
export function assertRecord(actual, expected) {
  assert.ok(actual);
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'paid_at') assert.equal(Date.parse(actual[key]), Date.parse(value));
    else assert.deepEqual(actual[key], value, `History mismatch: ${key}`);
  }
}
