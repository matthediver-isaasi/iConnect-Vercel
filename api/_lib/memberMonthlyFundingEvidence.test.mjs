import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemberMonthlyFundingEvidence } from './memberMonthlyFundingEvidence.js';
function fixture() {
  return {
    input:{memberId:'member',effectiveDate:'2026-02-15',purchase:{id:'purchase'},
      agreement:{id:'agreement'},plan:{id:'plan'},authority:{provider:'gocardless',currency:'GBP'}},
    funding:{sourceRecordId:'purchase',agreementId:'agreement',planId:'plan',provider:'gocardless',
      currency:'GBP',settledGrossMinor:1200,pendingGrossMinor:0,
      payments:[{id:'PM1',date:'2026-01-20',amountMinor:1200,settled:true}]},
    service:{evidence:{sourceRecordId:'purchase',currency:'GBP',throughExclusiveDate:'2026-02-15',
      complete:true,periods:[{evidenceId:'reservation:invoice',providerPaymentId:'PM1',
        collectionDate:'2026-01-20',sourceRecordId:'purchase',currency:'GBP',verified:true,
        netMinor:1000,vatMinor:200,grossMinor:1200}]}}
  };
}
test('cash evidence comes from provider settlement; tax amounts come from the linked invoice',()=>{
  const f=fixture(),result=buildMemberMonthlyFundingEvidence(f);
  assert.equal(result.settledFunding[0].netMinor,1000);
  assert.equal(result.settledFunding[0].vatMinor,200);
  assert.equal(result.settledFunding[0].ownerId,'member');
  assert.equal(result.variableMonthlyService,f.service.evidence);
  assert.equal(result.complete,true);
});
test('unpaid invoices, mismatched cash amounts, missing invoices and duplicate cash cannot become credit',()=>{
  const edits=[
    f=>{f.funding.payments[0].settled=false},
    f=>{f.funding.payments[0].amountMinor=1000},
    f=>{f.service.evidence.periods=[]},
    f=>{f.funding.payments.push({...f.funding.payments[0]})},
    f=>{f.funding.payments.push({...f.funding.payments[0],id:'PM2'})},
    f=>{f.funding.pendingGrossMinor=1200},
    f=>{f.funding.settledGrossMinor=1199},
    f=>{f.service.evidence.periods[0].collectionDate='2026-01-15'},
    f=>{delete f.service.evidence.periods[0].collectionDate},
    f=>{f.service.evidence.periods[0].sourceRecordId='foreign'},
  ];
  for(const edit of edits){const f=fixture();edit(f);assert.throws(()=>buildMemberMonthlyFundingEvidence(f));}
});
test('a collection date differs legitimately from its service anniversary, but must match actual payment evidence',()=>{
  const f=fixture();
  f.service.evidence.periods[0].serviceStartDate='2026-01-15';
  f.service.evidence.periods[0].serviceEndExclusiveDate='2026-02-15';
  assert.equal(buildMemberMonthlyFundingEvidence(f).settledFunding[0].grossMinor,1200);
});
