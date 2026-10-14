import assert from 'node:assert/strict';
import {sha, TENANT} from './bnms-approved-72-core.mjs';
import {HISTORICAL_ENTITLEMENT_SOURCE, isBnmsHistoricalEntitlement} from '../api/_lib/bnmsHistoricalEntitlement.js';
export const APPROVAL = Object.freeze({
  '43635bda-4611-4d24-9f22-245bf7b22ef0': ['2026-08-22','operator_confirmed_paid'],
  '69ad7a2b-23fd-4c6f-aa3a-b100b3c6c8cf': ['2026-07-28','xero_authorised_payments'],
  '979d3059-213a-4c3c-aed6-064c517e7d20': ['2026-09-30','entitlement_only_not_cash_payment'],
  'a2677319-a18f-446e-b50b-ba78b46c88a9': ['2026-08-22','xero_authorised_payments'],
  'eb70e43b-1cb5-4eb6-ab00-2d43aab1afa1': ['2026-08-17','xero_authorised_payments'],
  'ec80cf30-1119-4a52-8036-dab696380e03': ['2026-07-25','operator_confirmed_paid'],
});
export const approvalHash = sha(JSON.stringify(APPROVAL));
export function buildHistoricalRecord(row, source, provider) {
  const approved = APPROVAL[row.memberId];
  assert.ok(approved, 'Member not approved');
  assert.equal(row.retainedExpiry, approved[0]);
  assert.equal(source.preferences.member_class, row.memberClass);
  const authority = approved[1], verified = authority === 'xero_authorised_payments';
  const h = sha(`${HISTORICAL_ENTITLEMENT_SOURCE}:${approvalHash}:${row.memberId}`);
  const notes = {source:HISTORICAL_ENTITLEMENT_SOURCE, version:1, approvalDate:'2026-10-14',
    scope:'historical_entitlement_only', memberId:row.memberId, expiry:approved[0], approvalHash,
    sourceHash:sha(JSON.stringify(source)), paymentAuthority:authority,
    startDateAuthority:'unknown_not_inferred', expiryAuthority:'operator_approved_retained_expiry',
    invoiceAuthority:verified ? 'verified_xero_payment' : 'unresolved_not_linked',
    futureCollectionConsent:false, providerWrites:0, ddEvidenceRecorded:source.dd_evidence,
    historicalPaymentInstrument:'unknown', historicalStructureAuthority:'member_class_not_current_price'};
  const record = {id:`${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`,
    tenant_id:TENANT, member_id:row.memberId, membership_year:'Legacy membership (start unknown)',
    tier_label:row.memberClass, field_value:row.memberClass, status:'expired',
    term_start_date:null, term_end_date:approved[0], billing_period:'annual',
    payment_status:authority === 'entitlement_only_not_cash_payment' ? 'unpaid' : 'paid',
    payment_method:authority === 'entitlement_only_not_cash_payment' ? 'direct_debit' : 'upfront'};
  for (const key of ['config_id','billing_agreement_id','annual_cost','prorata_cost',
    'final_cost','total_with_vat','vat_amount','currency','paid_at','accounting_provider',
    'accounting_invoice_id','accounting_invoice_number','xero_invoice_id','xero_invoice_number',
    'membership_renewal_date','renewal_policy_snapshot','commitment_snapshot','previous_term_id',
    'term_key','term_duration_months','term_anchor_date','membership_successor_election_id',
    'stripe_payment_intent_id','free_period_discount','rollover_discount','custom_discount_total']) record[key] = null;
  if (verified) {
    const i = provider.invoice, payments = provider.payments;
    assert.ok(!provider.identity.accountConflict && provider.identity.emailMatch && !provider.identity.duplicateContacts);
    assert.equal(i.Status,'PAID'); assert.equal(i.Type,'ACCREC'); assert.equal(i.CurrencyCode,'GBP');
    assert.equal(i.InvoiceNumber,row.invoice); assert.equal(i.AmountDue,0);
    assert.equal(i.AmountCredited || 0,0); assert.equal((i.CreditNotes || []).length,0);
    assert.equal(i.LineItems.length,1); assert.equal(i.LineItems[0].Quantity,1);
    assert.match(i.LineItems[0].Description, /membership/i);
    assert.equal(i.LineItems[0].LineAmount,row.membershipAmount); assert.equal(i.Total,row.membershipAmount);
    assert.equal(i.AmountPaid,i.Total); assert.equal(i.TotalTax,0); assert.equal(i.LineItems[0].TaxAmount,0);
    assert.ok(payments.length > 0 && payments.every(p => p.Status === 'AUTHORISED' && p.Amount > 0 && p.Invoice.InvoiceID === i.InvoiceID));
    assert.equal(payments.reduce((n,p) => n+p.Amount,0),i.Total);
    const dates = payments.map(p => Number(/\/Date\((\d+)/.exec(p.Date)?.[1]));
    assert.ok(dates.every(Number.isFinite));
    Object.assign(record,{annual_cost:i.Total, final_cost:i.Total, total_with_vat:i.Total, vat_amount:0,
      currency:'GBP', paid_at:new Date(Math.max(...dates)).toISOString(), accounting_provider:'xero',
      accounting_invoice_id:i.InvoiceID, accounting_invoice_number:i.InvoiceNumber,
      xero_invoice_id:i.InvoiceID, xero_invoice_number:i.InvoiceNumber});
    notes.invoiceId = i.InvoiceID; notes.paymentIds = payments.map(p => p.PaymentID).sort();
  }
  record.notes = JSON.stringify(notes);
  assert.ok(isBnmsHistoricalEntitlement(record));
  return record;
}
