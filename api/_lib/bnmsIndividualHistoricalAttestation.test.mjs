import test from 'node:test';
import assert from 'node:assert/strict';
import { INDIVIDUAL_HISTORY_SOURCE,isBnmsIndividualHistoricalAttestation } from './bnmsIndividualHistoricalAttestation.js';
import { isAttestedExpiryOnlyHistory } from './expiryOnlyRenewalPolicy.js';
import { NMC_TENANT,NMC_FIELDS,projectNmcReport } from './nmcMembershipReport.js';
const id='eda44595-1c5d-4bf8-8395-8c75b19774b5';
const h={id:'history',member_id:id,tenant_id:NMC_TENANT,term_end_date:'2026-08-27',
  status:'expired',payment_status:'paid',payment_method:'upfront',billing_period:'annual',
  membership_year:'Legacy membership (start unknown)',
  notes:{source:INDIVIDUAL_HISTORY_SOURCE,version:1,memberId:id,expiry:'2026-08-27',
    approvalDate:'2026-10-14',scope:'historical_entitlement_only',sourceHash:'a'.repeat(64),
    paymentAuthority:'operator_confirmed_paid',startDateAuthority:'unknown_not_inferred',
    invoiceAuthority:'not_verified_not_linked'}};
const report=reportDate=>projectNmcReport({reportDate,members:[{id,tenant_id:NMC_TENANT}],
  fields:NMC_FIELDS.map(name=>({id:name,name,tenant_id:NMC_TENANT,entity_scope:'member',is_active:true,
    options:name==='member_class'?['Full with NMC']:[]})),
  preferences:[{member_id:id,field_id:'member_class',value:'Full with NMC'}],
  history:[h],organizations:[]});
test('individual approval supports expired NMC reporting but not renewal policy authority',()=>{
  assert.equal(isBnmsIndividualHistoricalAttestation(h),true);
  assert.equal(isAttestedExpiryOnlyHistory(h,NMC_TENANT),false);
  assert.equal(report('2026-10-14').sheets[0].count,1);
  assert.equal(report('2026-10-14').rows[0].cells[12],'Expired');
  assert.equal(report('2026-11-26').excludedCounts.expired_over_90_days,1);
});
test('approval cannot be extended to another member, date, unpaid term or billing commitment',()=>{
  for(const change of [{member_id:'other'},{tenant_id:'other'},{term_end_date:'2027-08-27'},
    {payment_status:'unpaid'},{payment_method:'direct_debit'},{status:'cancelled'},
    {organization_id:'org'},{term_start_date:'2025-08-28'},{annual_cost:100},
    {billing_agreement_id:'agreement'},{notes:{...h.notes,scope:'renewal'}},
    {notes:{...h.notes,sourceHash:'invalid'}}])
    assert.equal(isBnmsIndividualHistoricalAttestation({...h,...change}),false);
});
