import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateAmendmentTerms} from './memberAmendmentCalculation.js';
import {planMemberCancellationFinance as plan} from './memberCancellationFinancialPlan.js';
import {MEMBERSHIP_CHANGE_POLICY_DEFAULTS} from './membershipChangePolicy.js';
const money=n=>({netMinor:n,vatMinor:0,grossMinor:n});
function fixture(paid=3000){
 const effectiveDate='2026-05-01',memberId='member',sourceRecordId='purchase';
 const funding={sourceRecordId,currency:'GBP',asOfDate:effectiveDate,complete:true,
  settledFunding:[{id:'cash',sourceRecordId,currency:'GBP',state:'settled',ownerType:'member',
   ownerId:memberId,kind:'cash',...money(paid)}],pendingCollections:[],failedCollections:[],outstandingDue:money(0),
  deliveredService:{sourceRecordId,throughExclusiveDate:effectiveDate,verified:true,...money(4000)}};
 const calculation=calculateAmendmentTerms({sourceRecordId,memberId,currency:'GBP',frequency:'monthly',
  sourcePrice:money(12000),term:{startDate:'2026-01-01',renewalDate:'2027-01-01'},
  effectiveDate,evidence:funding,action:'cancel',behaviour:'retain_term',cancellationTiming:'immediate'});
 return {requestId:'00000000-0000-4000-8000-000000000001',memberId,calculation,
  policy:{...MEMBERSHIP_CHANGE_POLICY_DEFAULTS,cancellationTiming:'immediate'},
  choice:'collect',issuedAt:'2026-05-01T12:00:00Z',
  evidence:{complete:true,sourceRecordId,currency:'GBP',contactId:'contact',providerTenantId:'books',
   pendingCollections:[],disputedPayments:[],invoices:[{id:'invoice',sourceRecordId,providerTenantId:'books',
    contactId:'contact',currency:'GBP',status:paid===12000?'PAID':'AUTHORISED',
    creditedMinor:0,prepaymentMinor:0,overpaymentMinor:0,accountCode:'400',taxCode:'NONE',
    amount:money(12000),paid:money(paid),due:money(12000-paid)}]}};
}
test('unused annual debt is credited without a duplicate earned-service invoice',()=>{
 const f=fixture(),result=plan(f);
 assert.equal(result.steps.filter(s=>s.kind==='invoice').length,0);
 assert.equal(result.steps.find(s=>s.kind==='allocation').amountMinor,
  12000-f.calculation.finance.consumed.grossMinor);
 assert.equal(result.debtMinor,f.calculation.paymentDueMinor);
 assert.equal(result.surplusMinor,0);
});
test('retained prepaid surplus does not create a spendable Xero credit note',()=>{
 const f=fixture(12000);f.choice='none';
 const result=plan(f);
 assert.deepEqual(result.steps.map(s=>s.kind),['original_invoice']);
 assert.equal(result.retainedPrepaidMinor,f.calculation.surplusMinor);
 assert.equal(result.surplusMinor,0);
});
test('personal credit requires liability backing and preserves configured expiry after approval',()=>{
 const f=fixture(12000);
 f.policy={...f.policy,cancellationUnusedValue:'tenant_surplus_policy',surplusHandling:'approval',creditExpiryDays:30};
 f.choice='credit';
 assert.throws(()=>plan(f),/liability/);
 f.liabilityBinding={accountId:'liability',provider:'xero',kind:'iconnect_member_credit_liability',
  providerTenantId:'books',currency:'GBP'};
 const result=plan(f);
 assert.equal(result.steps.at(-1).kind,'backing_payment');
 assert.equal(result.steps.at(-1).reference,result.steps.find(s=>s.key==='surplus_note').reference);
 assert.equal(result.returnAmount.grossMinor,f.calculation.surplusMinor);
 assert.equal(result.creditExpiresAt,'2026-05-31T12:00:00.000Z');
});
test('refund planning does not issue personal credit or treat the refund as already paid',()=>{
 const f=fixture(12000);f.policy={...f.policy,cancellationUnusedValue:'tenant_surplus_policy',surplusHandling:'refund'};
 f.choice='refund';const result=plan(f);
 assert.deepEqual(result.steps.map(s=>s.kind),['original_invoice','credit_note']);
 assert.equal(result.choice,'refund');
 assert.equal(result.paymentReactivatesMembership,false);
 assert.equal(result.accessWaitsForSettlement,false);
});
test('unverified balances, pending collections and funded ownership cannot authorize personal credit',()=>{
 const f=fixture();
 f.calculation.paymentDueMinor++;
 assert.throws(()=>plan(f),/requires reconciliation/);
 f.calculation.paymentDueMinor--;
 f.evidence.pendingCollections.push({id:'submitted'});
 assert.throws(()=>plan(f),/Complete, undisputed/);
 f.evidence.pendingCollections=[];
 f.calculation.finance.personalFundingOnly=false;
 assert.throws(()=>plan(f),/ownership/);
});

test('final term-end reconciliation retains earned unpaid instalments without another invoice',()=>{
 const f=fixture();
 const end='2027-01-01';
 f.calculation=calculateAmendmentTerms({sourceRecordId:'purchase',memberId:'member',currency:'GBP',
  frequency:'monthly',pricingBasis:'annual_instalments',sourcePrice:money(12000),
  term:{startDate:'2026-01-01',renewalDate:end},effectiveDate:end,
  action:'cancel',behaviour:'retain_term',cancellationTiming:'end_of_term',settlementAtTermEnd:true,
  evidence:{sourceRecordId:'purchase',currency:'GBP',asOfDate:end,complete:true,
   pendingCollections:[],failedCollections:[],outstandingDue:money(0),
   deliveredService:{sourceRecordId:'purchase',throughExclusiveDate:end,verified:true,...money(12000)},
   settledFunding:[{id:'cash',sourceRecordId:'purchase',currency:'GBP',state:'settled',
    ownerType:'member',ownerId:'member',kind:'cash',...money(3000)}]}});
 f.policy.cancellationTiming='end_of_term';f.issuedAt='2027-01-01T00:00:00Z';
 const result=plan(f);
 assert.equal(result.debtMinor,9000);
 assert.deepEqual(result.steps.map(s=>s.kind),['original_invoice']);
 assert.equal(result.receivables.unearnedCredit.grossMinor,0);
});
