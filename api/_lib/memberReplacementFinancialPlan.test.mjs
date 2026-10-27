import test from 'node:test';
import assert from 'node:assert/strict';
import {planMemberReplacementFinance} from './memberReplacementFinancialPlan.js';
const money=(netMinor,vatMinor=0)=>({netMinor,vatMinor,grossMinor:netMinor+vatMinor});
function fixture(target=7500){
 const source={id:'purchase',commitment_snapshot:{payment_frequency:'upfront'}};
 const unused=money(4167,833),price=money(target);
 const authority={action:'change',tenantId:'tenant',memberId:'member',sourceSnapshot:source,
  targetSnapshot:{nominal_code:'401',flat_vat_rate:'NONE'},
  calculation:{action:'change',behaviour:'new_term',blockers:[],effectiveDate:'2026-10-27',currency:'GBP',
   newTerm:{startDate:'2026-10-27',renewalDate:'2027-10-27'},
   newCost:price,unused,paymentDueMinor:Math.max(target-5000,0),surplusMinor:Math.max(5000-target,0),
   finance:{personalFundingOnly:true,voucherFunding:[],settled:money(8333,1667),original:money(8333,1667)}},
  fundingEvidence:{complete:true,sourceRecordId:'purchase',
   providerEvidence:{sourceInvoiceId:'old',contactId:'payer',providerTenantId:'books'},
   settledFunding:[{kind:'cash',ownerType:'member',ownerId:'member'}]},
  settlement:{surplusHandling:'approval'},
  creditLiabilityBinding:{provider:'xero',kind:'iconnect_member_credit_liability',accountId:'liability',
   accountCode:'850',currency:'GBP',providerTenantId:'books'}};
 return {authority,executionId:'00000000-0000-4000-8000-000000000001',
  original:{provider:'xero',sourceInvoiceId:'old',contactId:'payer',xeroTenantId:'books',
   originalPaidMinor:10000,originalPaymentIds:['paid'],accountCode:'400',taxCode:'OUTPUT2'},
  choice:target>5000?'collect':target<5000?'credit':'none'};
}
test('replacement invoices the whole new term and transfers only verified unused value',()=>{
 const p=planMemberReplacementFinance(fixture());
 assert.equal(p.steps[0].amount.grossMinor,7500);
 assert.equal(p.additionalPaymentMinor,2500);
 assert.deepEqual(p.transferred,money(4167,833));
 assert.equal(p.steps[0].accountCode,'401');
 assert.equal(p.steps[1].accountCode,'400');
 assert.equal(p.steps[1].taxCode,'OUTPUT2');
 assert.equal(p.entitlementApplied,false);
});
test('separate transfer and surplus notes preserve original tax to the penny',()=>{
 const p=planMemberReplacementFinance(fixture(3000));
 assert.deepEqual(p.transferred,money(2500,500));
 assert.deepEqual(p.surplus,money(1667,333));
 assert.equal(p.steps.filter(s=>s.kind==='credit_note').reduce((n,s)=>n+s.amount.grossMinor,0),5000);
 assert.equal(p.additionalPaymentMinor,0);
 assert.equal(p.steps.at(-1).reference,`MA:${p.executionId}`);
 assert.equal(planMemberReplacementFinance(fixture(5000)).choice,'none');
});
test('unverified ownership, changed payer, unsupported funds and policy mismatches fail closed',()=>{
 for(const change of [
  f=>f.authority.fundingEvidence.settledFunding[0].ownerType='organization',
  f=>f.authority.fundingEvidence.settledFunding[0].kind='voucher',
  f=>f.original.contactId='other',f=>f.original.xeroTenantId='other',
  f=>f.original.originalPaidMinor=9999,f=>f.authority.calculation.blockers=['pending'],
  f=>f.authority.calculation.paymentDueMinor=1,f=>f.authority.targetSnapshot.nominal_code='',
  f=>f.choice='refund',
 ]){
  const f=fixture();change(f);assert.throws(()=>planMemberReplacementFinance(f));
 }
 const f=fixture(3000);f.authority.settlement.surplusHandling='refund';
 assert.throws(()=>planMemberReplacementFinance(f));
});
