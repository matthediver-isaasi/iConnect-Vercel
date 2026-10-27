import test from 'node:test';
import assert from 'node:assert/strict';
import {
  amendmentDay,amendmentTermDays,prorateAmendmentMoney,
  reconcileAmendmentFunding,calculateAmendmentTerms,
} from './memberAmendmentCalculation.js';
import {MEMBERSHIP_CHANGE_POLICY_DEFAULTS,planMembershipChangeSettlement,resolveMembershipChangeBehaviour} from './membershipChangePolicy.js';

const money=(netMinor,vatMinor=0)=>({netMinor,vatMinor,grossMinor:netMinor+vatMinor});
function fixture() {
  // Leap-year term is 366 days; 2 July is exactly 183 days into it.
  return {
    sourceRecordId:'purchase',memberId:'member',currency:'GBP',frequency:'upfront',
    sourcePrice:money(10000),term:{startDate:'2024-01-01',renewalDate:'2025-01-01'},
    effectiveDate:'2024-07-02',behaviour:'retain_term',targetPrice:money(7500),
    targetTerm:{startDate:'2024-07-02',renewalDate:'2025-07-02'},
    evidence:{
      sourceRecordId:'purchase',currency:'GBP',asOfDate:'2024-07-02',complete:true,
      pendingCollections:[],failedCollections:[],outstandingDue:money(0),
      settledFunding:[{id:'settled-payment',state:'settled',sourceRecordId:'purchase',
        currency:'GBP',ownerType:'member',ownerId:'member',kind:'cash',...money(10000)}],
    },
  };
}
test('acceptance: £100 to £75 halfway through the term leaves £12.50 retaining renewal',()=>{
  const f=fixture(),before=JSON.stringify(f),q=calculateAmendmentTerms(f);
  assert.equal(q.unused.grossMinor,5000);assert.equal(q.newCost.grossMinor,3750);
  assert.equal(q.paymentDueMinor,0);assert.equal(q.surplusMinor,1250);
  assert.equal(q.newTerm.renewalDate,f.term.renewalDate);
  assert.equal(q.entitlementApplied,false);assert.equal(q.settlementStatus,'not_started');
  assert.equal(JSON.stringify(f),before);
});
test('acceptance: £100 to £75 halfway through the term costs £25 with a new term',()=>{
  const q=calculateAmendmentTerms({...fixture(),behaviour:'new_term'});
  assert.equal(q.unused.grossMinor,5000);assert.equal(q.newCost.grossMinor,7500);
  assert.equal(q.paymentDueMinor,2500);assert.equal(q.surplusMinor,0);
  assert.deepEqual(q.newTerm,{startDate:'2024-07-02',renewalDate:'2025-07-02'});
});
test('upgrade uses remaining actual days and separates net/tax minor units',()=>{
  const f=fixture();f.targetPrice=money(20000,4000);
  const q=calculateAmendmentTerms(f);
  assert.deepEqual(q.delta,money(5000,2000));
  assert.equal(q.paymentDueMinor,7000);
});
test('monthly member paid £60 for £60 delivered service has no £60 credit',()=>{
  const f=fixture();f.frequency='monthly';f.sourcePrice=money(12000);
  f.evidence.settledFunding[0]={...f.evidence.settledFunding[0],...money(6000)};
  f.evidence.deliveredService={sourceRecordId:f.sourceRecordId,throughExclusiveDate:f.effectiveDate,verified:true,...money(6000)};
  const q=calculateAmendmentTerms(f);
  assert.equal(q.unused.grossMinor,0);assert.equal(q.surplusMinor,0);
  assert.equal(q.paymentDueMinor,null);assert.equal(q.futureObligationMinor,3750);
  assert.equal(q.canAutomaticallySettle,false);
  assert.ok(q.blockers.includes('provider_schedule_coordination_required'));
});
test('monthly genuine advance collection minus delivered service yields only prepaid value',()=>{
  const f=fixture();f.frequency='monthly';f.sourcePrice=money(12000);
  f.evidence.settledFunding[0]={...f.evidence.settledFunding[0],...money(7000)};
  f.evidence.deliveredService={sourceRecordId:f.sourceRecordId,throughExclusiveDate:f.effectiveDate,verified:true,...money(6000)};
  assert.equal(calculateAmendmentTerms(f).unused.grossMinor,1000);
});
test('monthly missing historical earned-service evidence never assumes annual price / 12',()=>{
  const f=fixture();f.frequency='monthly';
  assert.throws(()=>calculateAmendmentTerms(f),/delivered-service/);
});
test('pending and failed collections prevent automatic settlement without fabricating funding',()=>{
  for(const kind of ['pendingCollections','failedCollections']) {
    const f=fixture();f.evidence[kind]=['collection'];
    const q=calculateAmendmentTerms(f);
    assert.equal(q.unused.grossMinor,5000);assert.equal(q.canAutomaticallySettle,false);
  }
  const f=fixture();f.evidence.settledFunding[0].state='pending';
  assert.throws(()=>calculateAmendmentTerms(f),/settlement/);
});
test('partial payments and previously reduced funding require reconciliation',()=>{
  const f=fixture();f.evidence.settledFunding[0]={...f.evidence.settledFunding[0],...money(6000)};
  const q=calculateAmendmentTerms(f);
  assert.equal(q.unused.grossMinor,1000);assert.equal(q.canAutomaticallySettle,false);
  assert.ok(q.blockers.includes('partial_or_adjusted_purchase_requires_reconciliation'));
});
test('outstanding liabilities do not disappear behind unused value',()=>{
  const f=fixture();f.evidence.outstandingDue=money(1000);
  const q=calculateAmendmentTerms(f);
  assert.equal(q.finance.outstanding.grossMinor,1000);assert.equal(q.canAutomaticallySettle,false);
});
test('original discounted commitment, not advertised price, is the source of value',()=>{
  const f=fixture();f.sourcePrice=money(8000);
  f.evidence.settledFunding[0]={...f.evidence.settledFunding[0],...money(8000)};
  assert.equal(calculateAmendmentTerms(f).unused.grossMinor,4000);
});
test('organisation or third-party money never becomes automatic personal credit',()=>{
  for(const ownerType of ['organization','third_party']) {
    const f=fixture();f.evidence.settledFunding[0].ownerType=ownerType;
    const q=calculateAmendmentTerms(f);
    assert.equal(q.canAutomaticallySettle,false);assert.equal(q.finance.personalFundingOnly,false);
    assert.ok(q.blockers.includes('non_member_funding'));
  }
});
test('voucher funding remains identified for source-aware returns, not cash refunds',()=>{
  const f=fixture();f.evidence.settledFunding[0].kind='voucher';
  assert.deepEqual(calculateAmendmentTerms(f).finance.voucherFunding,['settled-payment']);
});
test('immediate cancellation computes unused value but does not terminate a provider',()=>{
  const q=calculateAmendmentTerms({...fixture(),action:'cancel'});
  assert.equal(q.membershipEndExclusiveDate,'2024-07-02');
  assert.equal(q.surplusMinor,5000);assert.equal(q.entitlementApplied,false);
});
test('immediate annual-instalment cancellation charges service only, not the unused annual balance',()=>{
  for(const [paid,due,surplus] of [[6000,0,0],[4000,2000,0],[7000,0,1000]]){
    const f=fixture();
    Object.assign(f,{frequency:'monthly',pricingBasis:'annual_instalments',sourcePrice:money(12000),action:'cancel'});
    f.evidence.settledFunding[0]={...f.evidence.settledFunding[0],...money(paid)};
    f.evidence.deliveredService={sourceRecordId:f.sourceRecordId,throughExclusiveDate:f.effectiveDate,verified:true,...money(6000)};
    // This is the same debt, not an additional fee.
    f.evidence.outstandingDue=money(due);
    const q=calculateAmendmentTerms(f);
    assert.equal(q.cancellationChargeBasis,'service_used');
    assert.equal(q.paymentDueMinor,due);
    assert.equal(q.futureObligationMinor,0);
    assert.equal(q.surplusMinor,surplus);
    assert.ok(q.blockers.includes('cancellation_receivables_reconciliation_required'));
    assert.equal(q.canAutomaticallySettle,false);
    const plan=planMembershipChangeSettlement({calculation:q,
      policy:{...MEMBERSHIP_CHANGE_POLICY_DEFAULTS,cancellationTiming:'immediate',
        cancellationUnusedValue:'tenant_surplus_policy',surplusHandling:'credit'},issuedAt:'2024-07-02'});
    assert.equal(plan.paymentDueMinor,due);
    assert.equal(plan.surplusEligibleMinor,surplus);
    assert.equal(plan.cancellationChargeBasis,'service_used');
    assert.equal(plan.retainedPrepaidMinor,0);
    assert.ok(plan.blockers.includes('cancellation_receivables_reconciliation_required'));
    const noRefund=planMembershipChangeSettlement({calculation:q,
      policy:{...MEMBERSHIP_CHANGE_POLICY_DEFAULTS,cancellationTiming:'immediate'},issuedAt:'2024-07-02'});
    assert.equal(noRefund.surplusEligibleMinor,0);
    assert.equal(noRefund.retainedPrepaidMinor,surplus);
    if(due)assert.ok(plan.blockers.includes('outstanding_obligations'));
    const old={...q};delete old.cancellationChargeBasis;
    assert.throws(()=>planMembershipChangeSettlement({calculation:old,
      policy:MEMBERSHIP_CHANGE_POLICY_DEFAULTS,issuedAt:'2024-07-02'}),/must be refreshed/);
  }
});
test('immediate cancellation never treats in-flight collections or another owner’s funding as settled personal cash',()=>{
  for(const mutate of [
    f=>f.evidence.pendingCollections.push('pending-payment'),
    f=>f.evidence.failedCollections.push('failed-payment'),
    f=>f.evidence.settledFunding[0].ownerType='organization',
  ]){
    const f={...fixture(),action:'cancel'};mutate(f);
    const q=calculateAmendmentTerms(f);
    const plan=planMembershipChangeSettlement({calculation:q,
      policy:{...MEMBERSHIP_CHANGE_POLICY_DEFAULTS,cancellationTiming:'immediate',
        cancellationUnusedValue:'tenant_surplus_policy',surplusHandling:'credit'},issuedAt:'2024-07-02'});
    assert.equal(q.canAutomaticallySettle,false);
    assert.equal(plan.status,'requires_reconciliation');
    assert.equal(plan.moneyMoved,false);
    assert.equal(plan.entitlementApplied,false);
  }
});
test('cancellation preserves tax components and never turns excluded future service into credit',()=>{
  const f=fixture();
  Object.assign(f,{frequency:'monthly',pricingBasis:'annual_instalments',sourcePrice:money(10000,2000),action:'cancel'});
  f.evidence.settledFunding[0]={...f.evidence.settledFunding[0],...money(4000,800)};
  f.evidence.deliveredService={sourceRecordId:f.sourceRecordId,throughExclusiveDate:f.effectiveDate,verified:true,...money(5000,1000)};
  const q=calculateAmendmentTerms(f);
  assert.deepEqual(q.delta,money(1000,200));
  assert.equal(q.paymentDueMinor,1200);
  assert.equal(q.surplusMinor,0);
  const end=calculateAmendmentTerms({...f,cancellationTiming:'end_of_term'});
  assert.equal(end.cancellationChargeBasis,undefined);
  assert.equal(end.paymentDueMinor,null);
  assert.equal(end.membershipEndExclusiveDate,f.term.renewalDate);
});
test('end-of-term cancellation retains remaining service, with no refund today',()=>{
  const q=calculateAmendmentTerms({...fixture(),action:'cancel',cancellationTiming:'end_of_term'});
  assert.equal(q.membershipEndExclusiveDate,'2025-01-01');
  assert.equal(q.surplusMinor,0);assert.equal(q.paymentDueMinor,0);
});
test('foreign, stale, incomplete, duplicate and unverified evidence fails closed',()=>{
  for(const mutate of [
    f=>f.evidence.complete=false,
    f=>f.evidence.currency='USD',
    f=>f.evidence.sourceRecordId='another',
    f=>f.evidence.asOfDate='2024-07-01',
    f=>f.evidence.settledFunding.push({...f.evidence.settledFunding[0]}),
    f=>f.evidence.settledFunding[0].currency='USD',
    f=>delete f.evidence.outstandingDue,
  ]) {
    const f=fixture();mutate(f);assert.throws(()=>calculateAmendmentTerms(f));
  }
});
test('future, expired and invalid term dates are not current-membership amendments',()=>{
  for(const effectiveDate of ['2023-12-31','2025-01-01','2025-01-02','2024-02-30','2024-7-2']) {
    assert.throws(()=>calculateAmendmentTerms({...fixture(),effectiveDate}));
  }
  assert.throws(()=>amendmentDay('2025-02-29'));
  assert.equal(amendmentTermDays('2024-01-01','2025-01-01','2024-07-02').remainingDays,183);
});
test('tiny prices conserve pennies across consumed and remaining service',()=>{
  const f=fixture();f.sourcePrice=money(1,1);
  f.evidence.settledFunding[0]={...f.evidence.settledFunding[0],...money(1,1)};
  const q=reconcileAmendmentFunding(f);
  assert.equal(q.available.grossMinor+q.consumed.grossMinor,2);
  assert.deepEqual(prorateAmendmentMoney(money(1,1),1,2),money(1,1));
});
test('invalid money, unsafe integers and malformed replacement terms are rejected',()=>{
  for(const netMinor of [-1,1.5,'100',NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) {
    assert.throws(()=>prorateAmendmentMoney({netMinor,vatMinor:0},1,2));
  }
  assert.throws(()=>calculateAmendmentTerms({...fixture(),behaviour:'new_term',targetTerm:{startDate:'2024-07-03',renewalDate:'2025-07-03'}}));
  assert.throws(()=>calculateAmendmentTerms({...fixture(),behaviour:'guess'}));
  for(const currency of ['JPY','KWD','ZZZ'])assert.throws(()=>calculateAmendmentTerms({...fixture(),currency}),/currency/);
});
test('a downgrade starting a new term is still a downgrade even when payment is due',()=>{
  const calculation=calculateAmendmentTerms({...fixture(),behaviour:'new_term'});
  const plan=planMembershipChangeSettlement({calculation,policy:MEMBERSHIP_CHANGE_POLICY_DEFAULTS,issuedAt:'2024-07-02T12:00:00Z'});
  assert.equal(plan.changeType,'downgrade');assert.equal(plan.requiresApproval,true);
  assert.equal(plan.paymentDueMinor,2500);assert.equal(plan.moneyMoved,false);
});
test('retained surplus defaults to approval; explicit credit has nullable or dated expiry',()=>{
  const calculation=calculateAmendmentTerms(fixture()),issuedAt='2024-07-02T12:00:00Z';
  const defaults=planMembershipChangeSettlement({calculation,policy:MEMBERSHIP_CHANGE_POLICY_DEFAULTS,issuedAt});
  assert.equal(defaults.status,'pending_approval');assert.equal(defaults.surplusHandling,'approval');
  const policy={...MEMBERSHIP_CHANGE_POLICY_DEFAULTS,surplusHandling:'credit',downgradesRequireApproval:false};
  const noExpiry=planMembershipChangeSettlement({calculation,policy,issuedAt});
  assert.equal(noExpiry.creditExpiresAt,null);assert.equal(noExpiry.surplusEligibleMinor,1250);
  assert.equal(noExpiry.status,'ready_for_settlement');assert.equal(noExpiry.entitlementApplied,false);
  const dated=planMembershipChangeSettlement({calculation,policy:{...policy,creditExpiryDays:30},issuedAt});
  assert.equal(dated.creditExpiresAt,'2024-08-01T12:00:00.000Z');
});
test('cash refund choice must be explicitly configured and cannot refund voucher funding as cash',()=>{
  const f=fixture();f.evidence.settledFunding[0].kind='voucher';
  const plan=planMembershipChangeSettlement({calculation:calculateAmendmentTerms(f),
    policy:{...MEMBERSHIP_CHANGE_POLICY_DEFAULTS,surplusHandling:'refund',downgradesRequireApproval:false}});
  assert.equal(plan.status,'requires_reconciliation');assert.equal(plan.moneyMoved,false);
  assert.ok(plan.blockers.includes('original_voucher_return_required'));
});
test('cancellation unused-value policy and current timing are applied explicitly',()=>{
  const calculation=calculateAmendmentTerms({...fixture(),action:'cancel'});
  assert.throws(()=>planMembershipChangeSettlement({calculation,policy:MEMBERSHIP_CHANGE_POLICY_DEFAULTS}),/policy changed/);
  const policy={...MEMBERSHIP_CHANGE_POLICY_DEFAULTS,cancellationTiming:'immediate'};
  assert.equal(planMembershipChangeSettlement({calculation,policy}).surplusEligibleMinor,0);
  assert.equal(planMembershipChangeSettlement({calculation,policy:{...policy,cancellationUnusedValue:'tenant_surplus_policy'}}).requiresApproval,true);
});
test('the governing source schedule determines term policy, never destination or submitted values',()=>{
  const source={config_id:'source',tenant_id:'tenant'};
  assert.equal(resolveMembershipChangeBehaviour(source,{id:'source',tenant_id:'tenant'}),'retain_term');
  assert.equal(resolveMembershipChangeBehaviour(source,{id:'source',tenant_id:'tenant',membership_change_behaviour:'new_term'}),'new_term');
  assert.throws(()=>resolveMembershipChangeBehaviour(source,{id:'target',tenant_id:'tenant',membership_change_behaviour:'new_term'}));
  assert.throws(()=>resolveMembershipChangeBehaviour(source,{id:'source',tenant_id:'other'}));
});
