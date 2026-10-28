import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberCancellationFinancialPreparation} from './memberCancellationFinancialPreparation.js';
import {MEMBERSHIP_CHANGE_POLICY_DEFAULTS} from './membershipChangePolicy.js';
const REQUEST_ID='11111111-1111-4111-8111-111111111111';
function fixture(){
 const context={tenantId:'tenant',memberId:'member',actorId:'actor',isAdmin:true};
 const source={id:'purchase',tenant_id:'tenant',member_id:'member',currency:'GBP',
  final_cost:120,vat_amount:0,total_with_vat:120,term_start_date:'2026-01-01',
  membership_renewal_date:'2027-01-01',commitment_snapshot:{payment_frequency:'upfront'}};
 const original={provider:'xero',xeroTenantId:'books',sourceInvoiceId:'invoice',
  contactId:'payer',currency:'GBP',originalPaymentIds:['payment'],originalPaidMinor:12000,
  originalAmounts:{netMinor:12000,vatMinor:0,grossMinor:12000},accountCode:'200',taxCode:'NONE'};
 const record={id:REQUEST_ID,tenant_id:'tenant',member_id:'member',effective_date:'2026-05-01',
  access_ended_at:'2026-05-01T12:00:00Z',timing:'immediate',authority:{
   sourceSnapshot:source,policySnapshot:{policy:{...MEMBERSHIP_CHANGE_POLICY_DEFAULTS,cancellationTiming:'immediate'}},
   financialEvidence:{original:structuredClone(original)},
  }};
 let financial=null,writes=0,reads=0,loseResponse=false;
 const service=createMemberCancellationFinancialPreparation({db:{
  from(table){
   const q={select(){return q},eq(){return q},async maybeSingle(){
    return {data:table==='member_cancellation_request'?record:financial};
   }};return q;
  },
  async rpc(name,args){
   assert.equal(name,'prepare_member_cancellation_finance');writes++;
   financial={request_id:record.id,tenant_id:'tenant',member_id:'member',
    plan:args.p_plan,calculation:args.p_calculation,source_evidence:args.p_source_evidence};
   if(loseResponse)throw Error('response lost after commit');
   return {data:financial};
  },
 },finance:{async verifyOriginal(){reads++;return structuredClone(original)}},
 now:()=>new Date('2026-05-01T12:00:00Z')});
 return {service,context,record,original,get writes(){return writes},get reads(){return reads},
  lose(){loseResponse=true}};
}
test('prepaid cancellation previews retain default-policy unused cash without issuing credit',async()=>{
 const f=fixture(),p=await f.service.preview(f.context,REQUEST_ID);
 assert.equal(f.writes,0);assert.equal(p.plan.choice,'none');
 assert.ok(p.plan.retainedPrepaidMinor>0);
 const saved=await f.service.confirm(f.context,REQUEST_ID,{
  approve:true,expectedFingerprint:p.fingerprint,amountMinor:999999,invoiceId:'foreign',
 });
 assert.equal(saved.plan.choice,'none');
 assert.equal(saved.source_evidence.invoices[0].id,'invoice');assert.equal(f.writes,1);
});
test('lost approval response replays the existing immutable plan without reading changed accounting again',async()=>{
 const f=fixture(),p=await f.service.preview(f.context,REQUEST_ID);f.lose();
 await assert.rejects(f.service.confirm(f.context,REQUEST_ID,{approve:true,expectedFingerprint:p.fingerprint}),/response lost/);
 const reads=f.reads;f.original.originalPaymentIds=['changed'];
 const saved=await f.service.confirm(f.context,REQUEST_ID,{approve:true,expectedFingerprint:p.fingerprint});
 assert.equal(saved.plan.choice,'none');assert.equal(f.reads,reads);assert.equal(f.writes,1);
});
test('late, changed or monthly cash cannot be relabelled as refundable upfront money',async()=>{
 const f=fixture(),p=await f.service.preview(f.context,REQUEST_ID);
 f.original.originalPaymentIds=['later-payment'];
 await assert.rejects(f.service.confirm(f.context,REQUEST_ID,{approve:true,expectedFingerprint:p.fingerprint}),/evidence changed/);
 delete f.record.authority.financialEvidence;
 await assert.rejects(f.service.preview(f.context,REQUEST_ID),/timing needs review/);
 f.record.authority.sourceSnapshot.commitment_snapshot.payment_frequency='monthly';
 await assert.rejects(f.service.preview(f.context,REQUEST_ID),{code:'cancellation_cash_unverified'});
 assert.equal(f.writes,0);
});
