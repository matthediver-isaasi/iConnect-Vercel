import test from 'node:test';
import assert from 'node:assert/strict';
import { isBnmsUnexpiredAttestation, UNEXPIRED_SOURCE } from './bnmsUnexpiredAttestation.js';
import { isAttestedExpiryOnlyHistory } from './expiryOnlyRenewalPolicy.js';
import { projectNmcReport, NMC_FIELDS, NMC_TENANT } from './nmcMembershipReport.js';
const notes = {source: UNEXPIRED_SOURCE, version: 1, memberId: 'm', expiry: '2027-03-19',
  paymentAuthority: 'operator_confirmed_paid', startDateAuthority: 'unknown_not_inferred',
  expiryAuthority: 'retained_legacy_expiry'};
const history = { id:'h', member_id:'m', tenant_id:NMC_TENANT, status:'active', payment_status:'paid',
  payment_method:'upfront', membership_year:'Legacy membership (start unknown)',
  term_end_date:'2027-03-19', notes:JSON.stringify(notes) };
test('new attestation supports reporting, not legacy renewal policy', () => {
  assert.equal(isBnmsUnexpiredAttestation(history), true);
  assert.equal(isAttestedExpiryOnlyHistory(history,NMC_TENANT), false);
});
test('wrong owner, expiry, evidence, status and financial commitment fail closed', () => {
  for (const change of [{tenant_id:'other'}, {member_id:'other'}, {term_end_date:'2028-01-01'},
    {payment_status:'unpaid'}, {status:'cancelled'}, {notes:'bad'}, {config_id:'config'},
    {billing_agreement_id:'agreement'}, {final_cost:10}, {term_start_date:'2026-03-20'}]) {
    assert.equal(isBnmsUnexpiredAttestation({...history,...change}),false);
  }
});
test('NMC includes new attested expiry-only history but still rejects unapproved evidence', () => {
  const fields=NMC_FIELDS.map(name=>({id:name,name,tenant_id:NMC_TENANT,entity_scope:'member',is_active:true,
    options:name==='member_class'?['Full with NMC']:[]}));
  const input={members:[{id:'m',tenant_id:NMC_TENANT}],fields,
    preferences:[{member_id:'m',field_id:'member_class',value:'Full with NMC'}],
    organizations:[],history:[history],reportDate:'2026-10-13'};
  assert.equal(projectNmcReport(input).sheets[0].count,1);
  assert.equal(projectNmcReport({...input,history:[{...history,notes:null}]}).total,0);
  assert.equal(projectNmcReport({...input,reportDate:'2027-06-19'}).excludedCounts.expired_over_90_days,1);
});
test('approved overseas attestation belongs in Full and Full Junior without financial inference', () => {
  const expiry = '2027-07-08';
  const overseasHistory = {...history,term_end_date:expiry,currency:null,
    notes:JSON.stringify({...notes,expiry,approvalScope:'single_overseas_nmc_member'})};
  const fields=NMC_FIELDS.map(name=>({id:name,name,tenant_id:NMC_TENANT,entity_scope:'member',is_active:true,
    options:name==='member_class'?['Overseas Full with NMC']:[]}));
  const input={members:[{id:'m',tenant_id:NMC_TENANT}],fields,
    preferences:[{member_id:'m',field_id:'member_class',value:'Overseas Full with NMC'}],
    organizations:[],history:[overseasHistory],reportDate:'2026-10-14'};
  assert.equal(projectNmcReport(input).sheets[0].count,1);
  assert.equal(isAttestedExpiryOnlyHistory(overseasHistory,NMC_TENANT),false);
  assert.equal(projectNmcReport({...input,history:[]}).reviewCounts.missing_membership_evidence,1);
});
