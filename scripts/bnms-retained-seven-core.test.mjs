import test from 'node:test';
import assert from 'node:assert/strict';
import {APPROVAL,buildHistoricalRecord} from './bnms-retained-seven-core.mjs';
import {TENANT} from './bnms-approved-72-core.mjs';
import {isBnmsHistoricalEntitlement} from '../api/_lib/bnmsHistoricalEntitlement.js';
import {NMC_FIELDS,projectNmcReport} from '../api/_lib/nmcMembershipReport.js';

function fixture(authority='operator_confirmed_paid') {
  const [id,[expiry]] = Object.entries(APPROVAL).find(([,a]) => a[1] === authority);
  const row = {memberId:id,retainedExpiry:expiry,memberClass:'Full junior with NMC',invoice:'fixture-invoice',membershipAmount:128};
  const source = {preferences:{member_class:row.memberClass},dd_evidence:authority === 'entitlement_only_not_cash_payment'};
  const provider = {identity:{emailMatch:true,accountConflict:false,duplicateContacts:false},
    invoice:{InvoiceID:'fixture-id',InvoiceNumber:row.invoice,Type:'ACCREC',CurrencyCode:'GBP',
      Status:'PAID',AmountDue:0,AmountPaid:128,Total:128,TotalTax:0,AmountCredited:0,
      LineItems:[{Description:'Junior Membership UK',Quantity:1,LineAmount:128,TaxAmount:0}]},
    payments:[{PaymentID:'fixture-payment',Status:'AUTHORISED',Amount:128,Date:'/Date(1757980800000+0000)/',Invoice:{InvoiceID:'fixture-id'}}]};
  return {row,source,provider,record:buildHistoricalRecord(row,source,provider)};
}
function report(record,reportDate='2026-10-14',extraHistory=[]) {
  return projectNmcReport({reportDate,history:[record,...extraHistory],
    members:[{id:record.member_id,tenant_id:TENANT,first_name:'Synthetic',last_name:'Member'}],
    fields:NMC_FIELDS.map(name => ({id:name,name,tenant_id:TENANT,entity_scope:'member',is_active:true,
      options:name === 'member_class' ? [{value:'Full junior with NMC'}] : null})),
    preferences:[{member_id:record.member_id,field_id:'member_class',value:'Full junior with NMC'}],
    organizations:[],roles:[],agreements:[],recognitions:[]});
}
test('six approvals exclude the unselected member and any wider cohort',() => {
  assert.equal(Object.keys(APPROVAL).length,6);
  const {row,source,provider} = fixture();
  for (const memberId of ['1be724c5-febf-563c-adbf-a8986ad46c79','unrelated']) {
    assert.throws(() => buildHistoricalRecord({...row,memberId},source,provider),/not approved/);
  }
  assert.throws(() => buildHistoricalRecord({...row,retainedExpiry:'2027-08-22'},source,provider));
});
for (const authority of ['operator_confirmed_paid','entitlement_only_not_cash_payment','xero_authorised_payments']) {
  test(`${authority}: historical record preserves unknown start and normal report expiry rules`,() => {
    const {record} = fixture(authority);
    assert.equal(record.term_start_date,null);
    assert.equal(record.membership_renewal_date,null);
    assert.equal(record.config_id,null);
    assert.equal(record.commitment_snapshot,null);
    assert.ok(isBnmsHistoricalEntitlement(record));
    assert.equal(report(record).total,1);
    assert.equal(report(record,'2027-10-14').excludedCounts.expired_over_90_days,1);
    assert.equal(report({...record,status:'cancelled'}).total,0);
    assert.equal(report({...record,notes:null}).total,0);
    const successor = {...record,id:'successor',previous_term_id:record.id,term_start_date:'2026-10-01',
      term_end_date:'2027-09-30',payment_status:'unpaid',notes:null};
    assert.equal(report(record,'2026-10-14',[successor]).total,0);
  });
}
test('entitlement alone never becomes cash payment or an invoice association',() => {
  const {record} = fixture('entitlement_only_not_cash_payment');
  assert.equal(record.payment_status,'unpaid');
  assert.equal(record.paid_at,null);
  assert.equal(record.currency,null);
  assert.equal(record.annual_cost,null);
  assert.equal(record.accounting_invoice_id,null);
  assert.equal(isBnmsHistoricalEntitlement({...record,payment_status:'paid'}),false);
  assert.equal(isBnmsHistoricalEntitlement({...record,accounting_invoice_id:'credit-invoice'}),false);
});
test('identity-unresolved attestation does not attach the available invoice or infer a price',() => {
  const {record} = fixture();
  assert.equal(record.payment_status,'paid');
  for (const k of ['paid_at','currency','annual_cost','accounting_invoice_id','xero_invoice_id']) assert.equal(record[k],null);
});
test('verified cash rejects credits, missing/failed payments, conflicting identity and current price inference',() => {
  for (const mutate of [
    p => {p.invoice.AmountCredited=128;},
    p => {p.invoice.CreditNotes=[{CreditNoteID:'credit'}];},
    p => {p.payments=[];},
    p => {p.payments[0].Status='DELETED';},
    p => {p.payments[0].Invoice.InvoiceID='other';},
    p => {p.identity.accountConflict=true;},
    p => {p.identity.duplicateContacts=true;},
    p => {p.invoice.Total=156;},
  ]) {
    const {row,source,provider} = fixture('xero_authorised_payments');
    mutate(provider);
    assert.throws(() => buildHistoricalRecord(row,source,provider));
  }
});
test('attestation bindings fail closed for tenant, member, expiry, provenance and renewal fields',() => {
  const {record} = fixture();
  for (const patch of [{tenant_id:'other'},{member_id:'other'},{term_end_date:'2026-02-31'},
    {term_end_date:'2027-08-22'},{term_start_date:'2025-08-23'},{billing_agreement_id:'agreement'},
    {renewal_policy_snapshot:{}},{commitment_snapshot:{}},{notes:'invalid json'}]) {
    assert.equal(isBnmsHistoricalEntitlement({...record,...patch}),false);
  }
});
