import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, MEMBER, TENANT, ORIGINAL, TARGET, INVOICE, CONFIG, RELATED } from './bnms-membership-5734-plan.mjs';

export function fixture() {
  const contact = { ContactID: 'b4a06c94-80d4-4745-807d-642656f268f5', AccountNumber: '56480412', EmailAddress: 'fixture@example.invalid' };
  const payment = { PaymentID: '523f9830-d836-462b-bb6c-e1da7ec1747a', Invoice: { InvoiceID: INVOICE },
    Status: 'AUTHORISED', Amount: 156, Date: '/Date(1788652800000+0000)/' };
  return {
    project: 'lvmzliemqnieeoruhkik', tenant: TENANT, member: MEMBER,
    owner: { id: MEMBER, tenant_id: TENANT, email: 'fixture@example.invalid' }, contact,
    preferences: [{ name: 'member_class', value: 'Overseas Full' },
      { name: 'ym_date_membership_expires', value: '05/10/2026' },
      { name: 'ym_web_site_member_id', value: '56480412' }],
    configs: [{ id: CONFIG, tenant_id: TENANT, name: '2026-2027 Overseas full member',
      structure_scope_type: 'member', structure_field_id: 'field', structure_match_value: 'Overseas Full',
      is_active: true, start_mode: 'immediate', billing_period: 'annual', currency: 'GBP',
      effective_from: '2026-01-01', effective_to: null, pricing_model: 'flat',
      renewal_change_role: true, renewal_open_days: 90, renewal_grace_days: 90, dd_auto_renew: true }],
    member_membership_history: [{ id: ORIGINAL, tenant_id: TENANT, member_id: MEMBER,
      term_start_date: null, term_end_date: '2026-10-05', config_id: null, accounting_invoice_id: null,
      xero_invoice_id: null, commitment_snapshot: null, notes: '{"source":"bnms_non_dd_current_backfill"}' }],
    ...Object.fromEntries(RELATED.map(t => [t, []])),
    historical_member_invoice: [{ invoice_number: '300005516', xero_document_id: INVOICE,
      xero_company_id: '3d57dce6-2205-462f-abf6-9c7cbf00be23' }],
    invoices: [{ InvoiceID: INVOICE, InvoiceNumber: '300005516', Contact: contact,
      DateString: '2026-09-06T00:00:00', Type: 'ACCREC', Status: 'PAID', CurrencyCode: 'GBP',
      Total: 156, AmountPaid: 156, AmountDue: 0, AmountCredited: 0, TotalTax: 0,
      LineItems: [{ Description: 'Full Membership Overseas', LineAmount: 156, TaxAmount: 0 }],
      Payments: [payment] }],
    payments: [payment],
  };
}

test('approved term preserves original history and financial evidence, without future policy', () => {
  const evidence = fixture(), before = structuredClone(evidence);
  const { record } = buildPlan(evidence);
  assert.equal(record.id, TARGET);
  assert.equal(record.term_start_date, '2026-10-06');
  assert.equal(record.term_end_date, '2027-10-05');
  assert.equal(record.paid_at, '2026-09-06T00:00:00.000Z');
  assert.equal(record.total_with_vat, 156);
  assert.equal(record.accounting_invoice_id, INVOICE);
  assert.equal(record.previous_term_id, null);
  assert.equal(record.commitment_snapshot.future_collection_consent, false);
  assert.ok(!Object.keys(record.commitment_snapshot.config).some(k => /^(renewal_|dd_)/.test(k)));
  assert.deepEqual(evidence, before);
});

for (const [label, change] of [
  ['wrong member', e => { e.owner.id = 'other'; }],
  ['changed class', e => { e.preferences[0].value = 'Full'; }],
  ['identity mismatch', e => { e.contact.AccountNumber = 'other'; }],
  ['changed expiry', e => { e.member_membership_history[0].term_end_date = '2027-10-05'; }],
  ['ambiguous mapping', e => { e.configs.push(e.configs[0]); }],
  ['wrong invoice', e => { e.invoices[0].InvoiceID = 'other'; }],
  ['partial settlement', e => { e.invoices[0].AmountPaid = 100; }],
  ['credit settlement', e => { e.invoices[0].AmountCredited = 156; }],
  ['deleted payment', e => { e.payments[0].Status = 'DELETED'; }],
  ['new agreement', e => { e.membership_billing_agreements.push({ id: 'new' }); }],
  ['competing later invoice', e => { e.invoices.push({ DateString: '2026-10-01T00:00:00' }); }],
]) test(`aborts on ${label}`, () => {
  const evidence = fixture(); change(evidence);
  assert.throws(() => buildPlan(evidence));
});
