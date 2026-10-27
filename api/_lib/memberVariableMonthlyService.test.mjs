import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileVariableMonthlyService} from './memberVariableMonthlyService.js';
import {reconcileAmendmentFunding,calculateAmendmentTerms} from './memberAmendmentCalculation.js';

const money=(netMinor,vatMinor=0)=>({netMinor,vatMinor,grossMinor:netMinor+vatMinor});
function fixture(start='2026-01-15',renewal='2026-04-15',through='2026-03-01') {
  return {sourceRecordId:'purchase',currency:'GBP',term:{startDate:start,renewalDate:renewal},
    throughExclusiveDate:through,evidence:{sourceRecordId:'purchase',currency:'GBP',
      throughExclusiveDate:through,complete:true,basis:'membership_start_anniversaries',periods:[]}};
}
function price(f,ordinal,start,end,net,vat=0) {
  f.evidence.periods.push({ordinal,evidenceId:`price-${ordinal}`,sourceRecordId:'purchase',currency:'GBP',
    serviceStartDate:start,serviceEndExclusiveDate:end,verified:true,...money(net,vat)});
  return f;
}
test('variable monthly cancellation uses anniversary service, not an annual-price assumption',()=>{
  const f=price(fixture('2026-01-15','2027-01-15','2026-01-30'),1,'2026-01-15','2026-02-15',1000);
  const consumed=reconcileVariableMonthlyService(f).grossMinor;
  for(const paid of [200,1000]){
    const q=calculateAmendmentTerms({
      sourceRecordId:f.sourceRecordId,memberId:'member',currency:f.currency,
      frequency:'monthly',pricingBasis:'monthly_price',sourcePrice:money(0),
      term:f.term,effectiveDate:f.throughExclusiveDate,behaviour:'retain_term',action:'cancel',
      evidence:{sourceRecordId:f.sourceRecordId,currency:f.currency,asOfDate:f.throughExclusiveDate,
        complete:true,pendingCollections:[],failedCollections:[],outstandingDue:money(0),
        variableMonthlyService:f.evidence,
        settledFunding:[{id:'payment',sourceRecordId:f.sourceRecordId,currency:f.currency,state:'settled',
          ownerType:'member',ownerId:'member',kind:'cash',...money(paid)}]},
    });
    assert.equal(q.cancellationChargeBasis,'service_used');
    assert.equal(q.paymentDueMinor,Math.max(consumed-paid,0));
    assert.equal(q.surplusMinor,Math.max(paid-consumed,0));
    assert.equal(q.futureObligationMinor,0);
    assert.equal(q.canAutomaticallySettle,false);
  }
});
test('uses each evidenced monthly price and prorates service days, not annual price/12',()=>{
  const f=price(price(fixture(),1,'2026-01-15','2026-02-15',1000,200),
    2,'2026-02-15','2026-03-15',2000,400);
  const before=structuredClone(f),result=reconcileVariableMonthlyService(f);
  assert.equal(result.netMinor,2000);assert.equal(result.vatMinor,400);
  assert.deepEqual(result.periods.map(p=>p.elapsedDays),[31,14]);
  assert.deepEqual(f,before);
});
test('late payments, changed collection days, failed collections do not redefine service used',()=>{
  const f=price(fixture(),1,'2026-01-15','2026-02-15',1000);
  price(f,2,'2026-02-15','2026-03-15',2000);
  const original=reconcileVariableMonthlyService(f);
  f.evidence.periods.forEach(p=>Object.assign(p,{collectionDate:'2026-03-25',paymentStatus:'failed'}));
  assert.deepEqual(reconcileVariableMonthlyService(f),original);
});
test('month-end anniversaries clamp independently across leap February',()=>{
  const f=fixture('2024-01-31','2024-05-31','2024-04-30');
  price(f,1,'2024-01-31','2024-02-29',1000);
  price(f,2,'2024-02-29','2024-03-31',1100);
  price(f,3,'2024-03-31','2024-04-30',1200);
  const result=reconcileVariableMonthlyService(f);
  assert.equal(result.netMinor,3300);
  assert.deepEqual(result.periods.map(p=>p.totalDays),[29,31,30]);
  assert.equal(result.periods.length,3); // No price required for an unstarted fourth period.
});
test('leap-day annual term reaches February 28, without shifting subsequent monthly anniversaries',()=>{
  const f=fixture('2024-02-29','2025-02-28','2024-04-29');
  price(f,1,'2024-02-29','2024-03-29',100);
  price(f,2,'2024-03-29','2024-04-29',200);
  assert.equal(reconcileVariableMonthlyService(f).netMinor,300);
});
test('term start consumes nothing; a shortened last period needs its own exact price evidence',()=>{
  assert.equal(reconcileVariableMonthlyService(fixture('2026-01-15','2026-02-05','2026-01-15')).grossMinor,0);
  const f=price(fixture('2026-01-15','2026-02-05','2026-02-05'),1,'2026-01-15','2026-02-05',700,140);
  assert.equal(reconcileVariableMonthlyService(f).grossMinor,840);
  f.evidence.periods[0].serviceEndExclusiveDate='2026-02-15';
  assert.throws(()=>reconcileVariableMonthlyService(f),/anniversaries/);
});
test('every penny of net and tax is conserved at each partial-day boundary',()=>{
  const f=price(fixture('2026-02-01','2026-03-01','2026-02-01'),1,'2026-02-01','2026-03-01',101,21);
  let previous=0;
  for(let day=1;day<=28;day++) {
    f.throughExclusiveDate=f.evidence.throughExclusiveDate=`2026-02-${String(day).padStart(2,'0')}`;
    const result=reconcileVariableMonthlyService(f);
    assert.ok(result.grossMinor>=previous);previous=result.grossMinor;
    if(day===1)continue;
    const {consumed,remaining}=result.periods[0];
    assert.equal(consumed.netMinor+remaining.netMinor,101);
    assert.equal(consumed.vatMinor+remaining.vatMinor,21);
  }
});
test('missing or ambiguous historical price evidence fails closed',()=>{
  const base=price(price(fixture(),1,'2026-01-15','2026-02-15',1000),2,'2026-02-15','2026-03-15',2000);
  for(const mutate of [
    f=>f.evidence.periods.pop(),
    f=>f.evidence.complete=false,
    f=>f.evidence.basis='collection_dates',
    f=>f.evidence.periods[1].sourceRecordId='foreign',
    f=>f.evidence.periods[1].currency='USD',
    f=>f.evidence.periods[1].verified=false,
    f=>f.evidence.periods[1].evidenceId='price-1',
    f=>f.evidence.periods[1].ordinal=1,
    f=>f.evidence.periods[1].netMinor=1.1,
    f=>f.evidence.periods[1].grossMinor=999,
    f=>f.evidence.periods[1].serviceStartDate='2026-02-20',
    f=>f.throughExclusiveDate='2026-02-30',
    f=>f.throughExclusiveDate='2026-05-01',
  ]) {
    const f=structuredClone(base);mutate(f);
    assert.throws(()=>reconcileVariableMonthlyService(f),{code:'amendment_evidence_required'});
  }
});
test('shared funding reconciliation consumes anniversary evidence and does not fabricate paid value',()=>{
  const f=price(price(fixture(),1,'2026-01-15','2026-02-15',1000),2,'2026-02-15','2026-03-15',2000);
  const input={sourceRecordId:'purchase',memberId:'member',currency:'GBP',frequency:'monthly',
    pricingBasis:'monthly_price',
    sourcePrice:money(99999),term:f.term,effectiveDate:f.throughExclusiveDate,
    evidence:{sourceRecordId:'purchase',currency:'GBP',asOfDate:f.throughExclusiveDate,complete:true,
      pendingCollections:[],failedCollections:[],outstandingDue:money(0),
      variableMonthlyService:f.evidence,
      deliveredService:{sourceRecordId:'purchase',throughExclusiveDate:f.throughExclusiveDate,verified:true,...money(0)},
      settledFunding:[{id:'paid',state:'settled',sourceRecordId:'purchase',currency:'GBP',
        ownerType:'member',ownerId:'member',kind:'cash',...money(2000)}]}};
  let result=reconcileAmendmentFunding(input);
  assert.equal(result.consumed.grossMinor,2000);
  assert.equal(result.available.grossMinor,0);
  assert.equal(result.deliveredServiceEvidence.periods.length,2);
  input.evidence.settledFunding[0]={...input.evidence.settledFunding[0],...money(1000)};
  result=reconcileAmendmentFunding(input);
  assert.equal(result.available.grossMinor,0);
  assert.ok(result.blockers.includes('outstanding_obligations'));
  input.evidence.variableMonthlyService=null;
  assert.throws(()=>reconcileAmendmentFunding(input),{code:'amendment_evidence_required'});
  delete input.evidence.variableMonthlyService;
  assert.throws(()=>reconcileAmendmentFunding(input),/anniversary-period service evidence/);
});
test('variable monthly changes cannot turn a current annual price into a guaranteed remaining obligation',()=>{
  assert.throws(()=>calculateAmendmentTerms({
    frequency:'monthly',pricingBasis:'monthly_price',action:'change',behaviour:'retain_term',
    targetPrice:money(12000),
  }),/effective-dated collection quote/);
});
