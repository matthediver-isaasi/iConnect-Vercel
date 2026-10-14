import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedCandidates, assertAssessment, buildRecord, historyId, REVIEW_HASH, CSV_HASH } from './bnms-approved-19-core.mjs';
import { historyId as earlierId } from './bnms-approved-72-core.mjs';

const fixture = () => ({
  candidate: {memberId:'fixture',memberClass:'Overseas Full',proposedStart:'2026-03-01',
    retainedExpiry:'2027-02-28',proposedRenewal:'2027-03-01',membershipAmount:156,aliasReconciled:true},
  config: {id:'config',billing_period:'annual',start_mode:'immediate',structure_match_value:'Overseas Full',flat_cost:999},
  provider: {latestPaidInvoiceId:'invoice',membershipInvoices:[{InvoiceID:'invoice',InvoiceNumber:'123',
    LineItems:[{LineItemID:'line',Description:'Full Membership Overseas',Quantity:1,LineAmount:156,TaxAmount:0}]}],
    payments:[{PaymentID:'payment',Date:'/Date(1772409600000+0000)/'}]},
});
test('pinned report rejects even plausible substitute cohorts and altered bytes',()=>{
  assert.throws(()=>approvedCandidates(Buffer.from('{"rows":[]}'),Buffer.from('csv')),/Reviewed report changed/);
});
test('individual provenance cannot accidentally inherit earlier cohort authority',()=>{
  const f=fixture(),r=buildRecord(f.candidate,f.config,f.provider,'provider-hash'),p=JSON.parse(r.notes);
  assert.equal(p.reviewSha256,REVIEW_HASH);assert.equal(p.csvSha256,CSV_HASH);
  assert.equal(p.source,'bnms_approved_19_xero_reconstruction');
  assert.equal(p.evidenceSha256,'provider-hash');assert.equal(p.overseasWordingReconciled,true);
  assert.equal(p.futureCollectionConsent,false);assert.equal(p.renewalPolicyAuthority,false);
  assert.equal(p.historicalPaymentInstrument,'unknown');assert.equal(p.originalQuoteAndConsent,'unknown');
  assert.equal(r.renewal_policy_snapshot,null);
  assert.equal(r.total_with_vat,156);assert.equal(r.field_value,'Overseas Full');
  assert.equal(r.term_start_date,'2026-03-01');assert.equal(r.term_end_date,'2027-02-28');
  assert.equal(r.id,historyId('fixture'));assert.notEqual(r.id,earlierId('fixture'));
});
test('changed class, term, amount, tax or missing payment date stops reconstruction',()=>{
  for(const change of [
    f=>f.config.structure_match_value='Full',
    f=>f.candidate.retainedExpiry='2027-03-01',
    f=>f.candidate.membershipAmount=999,
    f=>f.provider.membershipInvoices[0].LineItems[0].TaxAmount=1,
    f=>f.provider.payments=[],
  ]){const f=fixture();change(f);assert.throws(()=>buildRecord(f.candidate,f.config,f.provider,'hash'));}
});
test('live assessment must reproduce every approved evidence field',()=>{
  const a={memberId:'fixture',holds:[],conditionalCandidate:true,proposedStart:'2026-03-01',membershipAmount:156};
  assertAssessment(a,{...a,category:'extra report metadata'});
  for(const changed of [{...a,holds:['DD evidence needs reconciliation']},{...a,proposedStart:'2026-03-02'},{...a,membershipAmount:157}])
    assert.throws(()=>assertAssessment(changed,a));
});
