import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberCancellationAuthority} from './memberCancellationAuthority.js';
import {MEMBERSHIP_CHANGE_POLICY_DEFAULTS} from './membershipChangePolicy.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(){
 const context={tenantId:id(1),memberId:id(2),actorId:id(3),actorKind:'admin'};
 const source={id:id(4),tenant_id:id(1),member_id:id(2),status:'active',
  term_start_date:'2026-01-01',membership_renewal_date:'2027-01-01',currency:'GBP',
  final_cost:100,vat_amount:0,total_with_vat:100,commitment_snapshot:{payment_frequency:'upfront'}};
 const tables={member:[{id:id(2),tenant_id:id(1)}],member_membership_history:[source],
  membership_change_policy:[{tenant_id:id(1),revision:1,
   policy:{...MEMBERSHIP_CHANGE_POLICY_DEFAULTS,cancellationTiming:'immediate'}}]};
 let failed=false,reads=0;
 const db={from(table){
  let rows=tables[table]||[];const q={select(){return q},order(){return q},
   eq(key,value){rows=rows.filter(r=>r[key]===value);return q},
   async maybeSingle(){return rows.length>1?{error:{code:'multiple'}}:{data:rows[0]||null}},
   async range(start,end){return {data:rows.slice(start,end+1)}},
  };return q;
 }};
 const service=createMemberCancellationAuthority({db,now:()=>new Date('2026-07-01T12:00:00Z'),
  finance:{verifyOriginal:async()=>{reads++;if(failed)throw Error('provider unavailable');
   return {sourceInvoiceId:'original',originalPaidMinor:10000};}},
  provider:{prepareOwnedSubscription:async a=>({authority:a,fingerprint:'owned'})},
 });
 return {service,context,source,tables,get reads(){return reads},failFinance(){failed=true;}};
}
test('cancellation uses owned evidence, never browser prices or ownership',async()=>{
 const f=fixture(),result=await f.service.preview(f.context,{
  reason:'Cancel requested',memberId:id(9),paymentDueMinor:999999,sourceSnapshot:{id:id(8)},
 });
 assert.equal(result.authority.memberId,id(2));
 assert.equal(result.authority.sourceSnapshot.id,id(4));
 assert.equal(result.authority.calculation.finance.settled.grossMinor,10000);
 assert.equal(result.authority.calculation.accessWaitsForSettlement,false);
 assert.equal(result.authority.calculation.paymentReactivatesMembership,false);
 assert.equal(f.reads,1);
});
test('unavailable financial evidence is not represented as zero debt or paid settlement',async()=>{
 const f=fixture();f.failFinance();
 const {authority}=await f.service.preview(f.context,{reason:'Cancel requested'});
 assert.equal(authority.calculation.paymentDueMinor,null);
 assert.equal(authority.calculation.finance,null);
 assert.equal(authority.calculation.settlementStatus,'requires_reconciliation');
 assert.match(authority.financialReviewReason,/does not waive debt/);
 assert.equal(authority.effectiveDate,'2026-07-01');
});
test('monthly cancellation captures the source-owned subscription without changing it',async()=>{
 const f=fixture();
 f.source.billing_agreement_id=id(5);
 f.source.commitment_snapshot.payment_frequency='monthly';
 f.tables.membership_billing_agreements=[{id:id(5),tenant_id:id(1),member_id:id(2),
  provider:'stripe',environment:'test',agreement_type:'member',stripe_customer_id:'payer'}];
 f.tables.membership_payment_plans=[{id:id(6),tenant_id:id(1),member_id:id(2),
  billing_agreement_id:id(5),provider:'stripe',environment:'test',stripe_subscription_id:'sub'}];
 const {authority}=await f.service.preview(f.context,{reason:'Cancel',subscriptionId:'foreign'});
 assert.equal(authority.providerPrepared.authority.subscriptionId,'sub');
 assert.equal(authority.providerPrepared.authority.payerId,'payer');
 assert.equal(authority.calculation.paymentDueMinor,null);
 assert.equal(f.reads,0);
});
test('policy timing, owner, history ambiguity and actor protections fail closed',async()=>{
 const f=fixture();
 await assert.rejects(f.service.preview({...f.context,actorKind:'member'},{reason:'Cancel'}),/administrator/);
 await assert.rejects(f.service.preview(f.context,{reason:'Cancel',timing:'end_of_term'}),/policy/);
 await assert.rejects(f.service.preview({...f.context,tenantId:id(9)},{reason:'Cancel'}),/member/);
 f.tables.member_membership_history.push({...f.source,id:id(7)});
 await assert.rejects(f.service.preview(f.context,{reason:'Cancel'}),/Exactly one/);
});
test('end-of-term preview retains access until the existing renewal boundary',async()=>{
 const f=fixture();f.tables.membership_change_policy[0].policy.cancellationTiming='end_of_term';
 const {authority}=await f.service.preview(f.context,{reason:'Do not renew'});
 assert.equal(authority.effectiveDate,'2027-01-01');
 assert.equal(authority.calculation.membershipEndExclusiveDate,'2027-01-01');
 assert.equal(authority.calculation.entitlementApplied,false);
});
