import assert from 'node:assert/strict';
import { buildRollingCommitment } from '../../api/_lib/rollingMembershipCommitment.js';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const MEMBER = '23b0f721-27ff-4840-93f8-20379e90e901';
export const ORIGINAL = '36d03663-c9e3-5cad-a630-53f0a4776f9f';
export const TARGET = '586d4e57-598b-4dd2-ab9f-120f0be539a3';
export const INVOICE = 'be86600a-f39b-4a82-b659-5e5d536d8a4b';
export const CONFIG = '1e82bb61-a0b3-4e6c-8bad-92cb527cd0ce';
export const RELATED = ['historical_member_invoice', 'membership_billing_agreements',
  'membership_payment_plans', 'membership_payment_quote', 'membership_successor_election'];

export function buildPlan(evidence) {
  assert.equal(evidence.project, 'lvmzliemqnieeoruhkik');
  assert.equal(evidence.tenant, TENANT);
  assert.equal(evidence.member, MEMBER);
  assert.equal(evidence.owner.id, MEMBER);
  assert.equal(evidence.owner.tenant_id, TENANT);
  const pref = name => evidence.preferences.filter(p => p.name === name);
  assert.equal(pref('member_class').length, 1);
  assert.equal(pref('member_class')[0].value, 'Overseas Full');
  assert.equal(pref('ym_date_membership_expires')[0]?.value, '05/10/2026');
  assert.equal(pref('ym_web_site_member_id')[0]?.value, '56480412');
  assert.equal(evidence.contact.ContactID, 'b4a06c94-80d4-4745-807d-642656f268f5');
  assert.equal(evidence.contact.AccountNumber, '56480412');
  assert.ok(evidence.owner.email);
  assert.equal(evidence.owner.email.toLowerCase(), evidence.contact.EmailAddress?.toLowerCase());
  assert.equal(evidence.configs.length, 1);
  const config = evidence.configs[0];
  assert.equal(config.id, CONFIG);
  assert.equal(config.tenant_id, TENANT);
  assert.equal(config.structure_scope_type, 'member');
  assert.equal(config.structure_match_value, 'Overseas Full');
  assert.equal(config.is_active, true);
  assert.equal(config.start_mode, 'immediate');
  assert.equal(config.billing_period, 'annual');
  assert.ok(config.effective_from <= '2026-10-06');
  assert.ok(!config.effective_to || config.effective_to >= '2026-10-06');
  const existing = evidence.member_membership_history;
  assert.ok(existing.length >= 1 && existing.length <= 2);
  assert.ok(existing.every(h => h.id === ORIGINAL || h.id === TARGET));
  const original = existing.find(h => h.id === ORIGINAL);
  assert.ok(original);
  assert.equal(original.tenant_id, TENANT);
  assert.equal(original.member_id, MEMBER);
  assert.equal(original.term_start_date, null);
  assert.equal(original.term_end_date, '2026-10-05');
  assert.equal(original.config_id, null);
  assert.equal(original.accounting_invoice_id, null);
  assert.equal(original.xero_invoice_id, null);
  assert.equal(original.commitment_snapshot, null);
  assert.equal(JSON.parse(original.notes).source, 'bnms_non_dd_current_backfill');
  for (const table of RELATED.filter(t => t !== 'historical_member_invoice')) {
    assert.deepEqual(evidence[table], [], `Unexpected ${table}`);
  }
  assert.ok(evidence.historical_member_invoice.some(i => i.invoice_number === '300005516'
    && i.xero_document_id === INVOICE && i.xero_company_id === '3d57dce6-2205-462f-abf6-9c7cbf00be23'));
  const invoices = evidence.invoices.filter(i => i.InvoiceNumber === '300005516');
  assert.equal(invoices.length, 1);
  const invoice = invoices[0];
  assert.equal(invoice.InvoiceID, INVOICE);
  assert.equal(invoice.Contact.ContactID, evidence.contact.ContactID);
  assert.equal(invoice.DateString.slice(0, 10), '2026-09-06');
  assert.equal(invoice.Type, 'ACCREC');
  assert.equal(invoice.Status, 'PAID');
  assert.equal(invoice.CurrencyCode, 'GBP');
  assert.equal(invoice.Total, 156);
  assert.equal(invoice.AmountPaid, 156);
  assert.equal(invoice.AmountDue, 0);
  assert.equal(invoice.AmountCredited || 0, 0);
  assert.equal(invoice.TotalTax, 0);
  assert.equal(invoice.CreditNotes?.length || 0, 0);
  assert.equal(invoice.LineItems.length, 1);
  assert.equal(invoice.LineItems[0].Description, 'Full Membership Overseas');
  assert.equal(invoice.LineItems[0].LineAmount, 156);
  assert.equal(invoice.LineItems[0].TaxAmount, 0);
  assert.equal(invoice.Payments.length, 1);
  assert.equal(evidence.payments.length, 1);
  const payment = evidence.payments[0];
  assert.equal(payment.PaymentID, '523f9830-d836-462b-bb6c-e1da7ec1747a');
  assert.equal(payment.PaymentID, invoice.Payments[0].PaymentID);
  assert.equal(payment.Invoice.InvoiceID, INVOICE);
  assert.equal(payment.Status, 'AUTHORISED');
  assert.equal(payment.Amount, 156);
  const paidAt = new Date(Number(/\/Date\((\d+)/.exec(payment.Date)?.[1])).toISOString();
  assert.equal(paidAt, '2026-09-06T00:00:00.000Z');
  // Any later invoice is new evidence that invalidates this approved allocation.
  assert.ok(evidence.invoices.every(i => i.DateString <= invoice.DateString));
  // Structure identity/duration only: no authority to copy today's access,
  // future collection, grace or renewal-opening policies into historical consent.
  const snapshotConfig = Object.fromEntries(['id', 'tenant_id', 'name', 'currency',
    'start_mode', 'billing_period', 'structure_scope_type', 'structure_field_id',
    'structure_match_value', 'effective_from', 'effective_to', 'pricing_model']
    .map(k => [k, config[k]]));
  const amounts = { annual_cost: 156, final_cost: 156, vat_amount: 0, total_with_vat: 156, currency: 'GBP' };
  const commitment = buildRollingCommitment({
    config: snapshotConfig, startDate: '2026-10-06', paymentMethod: 'upfront',
    paymentFrequency: 'upfront', amounts, pricingSnapshot: { tier_label: 'Overseas Full', ...amounts },
  });
  assert.equal(commitment.term_end_date, '2027-10-05');
  commitment.commitment_snapshot.source = 'administrator_approved_historical_reconstruction';
  commitment.commitment_snapshot.structure_name = config.name;
  commitment.commitment_snapshot.future_collection_consent = false;
  const record = {
    id: TARGET, tenant_id: TENANT, member_id: MEMBER, config_id: CONFIG,
    membership_year: commitment.term_key, ...commitment, ...amounts,
    tier_label: 'Overseas Full', field_value: 'Overseas Full', billing_period: 'annual',
    status: 'active', payment_status: 'paid', payment_method: 'upfront', paid_at: paidAt,
    accounting_provider: 'xero', accounting_invoice_id: INVOICE, accounting_invoice_number: '300005516',
    xero_invoice_id: INVOICE, xero_invoice_number: '300005516',
    notes: JSON.stringify({
      source: 'bnms_single_member_owner_approved_invoice_term', version: 1,
      approval: { date: '2026-11-23', start: '2026-10-06', end: '2027-10-05',
        instruction: 'Owner selected 6 Oct 2026–5 Oct 2027 as invoice coverage after review of both annual invoices' },
      preservedHistoryId: ORIGINAL,
      termAuthority: 'explicit_owner_confirmed_coverage_not_invoice_date_inference',
      structureAuthority: 'current_member_class_mapping_not_original_purchase_configuration',
      paymentAuthority: 'xero_authorised_payment', invoiceId: INVOICE, paymentId: payment.PaymentID,
      futurePolicyAuthority: 'not_assigned_no_access_policy_or_collection_consent',
      futureCollectionConsent: false, providerFinancialWrites: 0,
    }),
  };
  return { record, original };
}

export function assertRecord(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'paid_at') assert.equal(Date.parse(actual[key]), Date.parse(value), key);
    else assert.deepEqual(actual[key], value, key);
  }
  for (const key of ['billing_agreement_id', 'membership_payment_quote_id',
    'membership_successor_election_id', 'renewal_policy_snapshot']) assert.equal(actual[key], null, key);
}
