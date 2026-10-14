import test from 'node:test';
import assert from 'node:assert/strict';
import { CORRECTED_EXPIRY_SOURCE, CORRECTED_EXPIRY_COHORT,
  CORRECTED_EXPIRY_APPROVAL_DATE, isBnmsCorrectedExpiryAttestation } from './bnmsCorrectedExpiryAttestation.js';
import { isAttestedExpiryOnlyHistory, prepareExpiryOnlyRenewalPolicies } from './expiryOnlyRenewalPolicy.js';
import { projectNmcReport, NMC_TENANT, NMC_FIELDS } from './nmcMembershipReport.js';

function history({ expiry='2027-07-04', dd=false, status='active' }={}) {
  return { id:'h',member_id:'m',tenant_id:NMC_TENANT,status,payment_status:'paid',
    membership_year:'Legacy membership (start unknown)',billing_period:'annual',
    payment_method:dd?'direct_debit':'upfront',term_end_date:expiry,
    notes:JSON.stringify({source:CORRECTED_EXPIRY_SOURCE,version:1,cohortHash:CORRECTED_EXPIRY_COHORT,
      approvalDate:CORRECTED_EXPIRY_APPROVAL_DATE,scope:'historical_entitlement_only',
      memberId:'m',expiry,sourceHash:'a'.repeat(64),ddEvidenceRecorded:dd,
      paymentAuthority:'operator_confirmed_paid',startDateAuthority:'unknown_not_inferred',
      expiryAuthority:'retained_corrected_legacy_expiry',invoiceAuthority:'not_verified_not_linked',
      historicalAmountAuthority:'unknown_not_inferred',currencyAuthority:'unknown_not_inferred'}) };
}
function report(h, klass='Full with NMC') {
  return projectNmcReport({members:[{id:'m',tenant_id:NMC_TENANT}],
    fields:NMC_FIELDS.map(name=>({id:name,name,tenant_id:NMC_TENANT,entity_scope:'member',is_active:true,
      options:name==='member_class'?[klass]:[]})),
    preferences:[{member_id:'m',field_id:'member_class',value:klass}],
    history:[h],organizations:[],reportDate:'2026-10-14'});
}
test('approved upfront and DD historical entitlement both support NMC without creating renewal authority', async()=>{
  for(const dd of [false,true]) {
    const h=history({dd});
    assert.equal(isBnmsCorrectedExpiryAttestation(h),true);
    assert.equal(report(h).sheets[0].count,1);
    assert.equal(isAttestedExpiryOnlyHistory(h,NMC_TENANT),false);
    const policies=await prepareExpiryOnlyRenewalPolicies({
      from(){throw Error('No policy lookup may be made for this reporting attestation');}
    },{tenantId:NMC_TENANT,histories:[h]});
    assert.equal(policies.size,0);
  }
});
test('expired histories retain the NMC 90-day rule and non-NMC classes remain online only',()=>{
  assert.equal(report(history({expiry:'2026-08-05',status:'expired',dd:true})).sheets[0].count,1);
  assert.equal(report(history({expiry:'2024-12-11',status:'expired'})).excludedCounts.expired_over_90_days,1);
  assert.equal(report(history(),'Trainee').sheets[3].count,1);
});
test('wrong owner, date, source, cohort, financial or renewal evidence fails closed',()=>{
  const h=history();
  for(const change of [{tenant_id:'other'},{member_id:'other'},{organization_id:'org'},
    {term_end_date:'2027-02-30'},{term_end_date:'2028-01-01'},{status:'cancelled'},
    {payment_status:'unpaid'},{payment_method:'direct_debit'},{notes:null},{notes:'broken'},
    {config_id:'config'},{billing_agreement_id:'agreement'},{term_start_date:'2026-07-05'},
    {currency:'GBP'},{final_cost:100},{paid_at:'2026-10-14'},{accounting_invoice_id:'invoice'},
    {membership_renewal_date:'2027-07-05'},{renewal_policy_snapshot:{}}]) {
    assert.equal(isBnmsCorrectedExpiryAttestation({...h,...change}),false,JSON.stringify(change));
  }
  for(const change of [{cohortHash:'b'.repeat(64)},{source:'other'},{ddEvidenceRecorded:true},
    {memberId:'other'},{paymentAuthority:'provider_paid'},{expiry:'2027-08-01'}]) {
    const altered={...h,notes:JSON.stringify({...JSON.parse(h.notes),...change})};
    assert.equal(isBnmsCorrectedExpiryAttestation(altered),false);
    assert.equal(report(altered).total,0);
  }
});
