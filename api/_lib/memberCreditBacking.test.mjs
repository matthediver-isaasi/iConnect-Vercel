import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectMemberCreditBacking,executeMemberCreditBacking,memberCreditBackingPayload} from './memberCreditBacking.js';
function fixture(){
 const context={xeroTenantId:'books',currency:'GBP',amounts:{grossMinor:1234},contactId:'payer',
  reference:'MA:change',issueDate:'2026-10-27',memberCreditLiabilityBinding:{
   provider:'xero',kind:'iconnect_member_credit_liability',providerTenantId:'books',
   currency:'GBP',accountId:'liability',accountCode:'850',
  }};
 const document={CreditNoteID:'note',Type:'ACCRECCREDIT',Status:'AUTHORISED',CurrencyCode:'GBP',
  Contact:{ContactID:'payer'},Reference:context.reference,Total:12.34,RemainingCredit:0,
  Allocations:[],Payments:[{PaymentID:'payment'}]};
 const payment={PaymentID:'payment',Status:'AUTHORISED',CreditNote:{CreditNoteID:'note'},
  Account:{AccountID:'liability'},Amount:12.34,Reference:'MA:change:member-credit',CurrencyRate:1};
 return {context,document,payment,request:async()=>({Payments:[payment]})};
}
test('backing proves consumption of the credit note into the pinned liability, not a cash refund',async()=>{
 const f=fixture(),r=await inspectMemberCreditBacking(f);
 assert.equal(r.state,'settled');assert.equal(r.evidence.kind,'member_credit_backed');
 assert.equal(r.evidence.retainedCreditMinor,0);
 assert.deepEqual(memberCreditBackingPayload(f.context,'note'),{Payments:[{
  CreditNote:{CreditNoteID:'note'},Account:{AccountID:'liability'},
  Amount:12.34,Date:'2026-10-27',Reference:'MA:change:member-credit',
 }]});
});
test('missing allocation/payment coverage and retained or partial spend never prove backing',async()=>{
 for(const patch of [{Allocations:undefined},{Payments:undefined},{Allocations:[{}]},
  {RemainingCredit:1},{Payments:[{PaymentID:'payment'},{PaymentID:'payment'}]},
  {Total:null},{Total:true},{Total:12.345},{Contact:{ContactID:'other'}},{CurrencyCode:'USD'},
  {Type:'ACCPAYCREDIT'},{Status:'VOIDED'}]){
  const f=fixture();Object.assign(f.document,patch);
  await assert.rejects(inspectMemberCreditBacking(f),{code:'credit_backing_evidence_required'});
 }
});
test('wrong-account, deleted, unrelated, partial and FX payments cannot issue credit',async()=>{
 for(const patch of [{Account:{AccountID:'bank'}},{Status:'DELETED'},{Amount:12.33},{Amount:null},
  {Reference:'cash refund'},{CreditNote:{CreditNoteID:'other'}},{CurrencyRate:0.99},{Invoice:{InvoiceID:'invoice'}}]){
  const f=fixture();Object.assign(f.payment,patch);
  await assert.rejects(inspectMemberCreditBacking(f),{code:'credit_backing_evidence_required'});
 }
});
test('write is claimed once; an ambiguous accepted response is recovered without another write',async()=>{
 const f=fixture();let claimed=false,writes=0,accepted=false;
 const pending={state:'awaiting_payment',evidence:{kind:'awaiting_member_credit_backing',documentId:'note'}};
 const args={tenantId:'tenant',amendmentId:'amendment',actorId:'actor',
  db:{rpc:async()=>{const first=!claimed;claimed=true;return {data:{claimed:first,context:f.context,documentId:'note'}}}},
  inspect:async()=>accepted?inspectMemberCreditBacking(f):pending,
  request:async(path,options)=>{writes++;assert.equal(path,'Payments');assert.equal(options.method,'PUT');
   assert.equal(options.body.Payments[0].Account.AccountID,'liability');
   accepted=true;throw Error('Response lost');},
 };
 await assert.rejects(executeMemberCreditBacking(args),/Response lost/);
 assert.equal((await executeMemberCreditBacking(args)).state,'settled');
 assert.equal(writes,1);
 accepted=false;
 assert.equal((await executeMemberCreditBacking(args)).state,'awaiting_payment');
 assert.equal(writes,1,'Claim alone never authorizes a replacement write');
});
test('failed reservation cannot submit a financial write',async()=>{
 await assert.rejects(executeMemberCreditBacking({
  db:{rpc:async()=>({error:{code:'40001'}})},
  inspect:async()=>({state:'awaiting_payment',evidence:{kind:'awaiting_member_credit_backing',documentId:'note'}}),
  request:async()=>assert.fail('No external write allowed'),
 }),{code:'credit_backing_reservation_failed'});
});
test('only an explicit throttled write records a retry, never a failed follow-up read',async()=>{
 const f=fixture(),pending={state:'awaiting_payment',evidence:{kind:'awaiting_member_credit_backing',documentId:'note'}};
 const throttled=()=>Object.assign(Error('Rate limited'),{status:429,code:'accounting_rate_limited',retryAfter:90});
 for(const mode of ['write429','timeout','read429','recordFailure','cooldown']){
  const calls=[];let reads=0,writes=0;
  const args={tenantId:'tenant',amendmentId:'amendment',actorId:'actor',
   db:{rpc:async(name,values)=>{
    calls.push({name,values});
    if(name==='record_member_credit_backing_throttle')return mode==='recordFailure'?{error:{code:'error'}}:{data:{}};
    return {data:{claimed:mode!=='cooldown',attempt:'retry-id',context:f.context,documentId:'note',
      ...(mode==='cooldown'?{retryAfter:30}:{})}};
   }},
   inspect:async()=>{if(++reads>1&&mode==='read429')throw throttled();return pending},
   request:async()=>{writes++;if(['write429','recordFailure'].includes(mode))throw throttled();
     if(mode==='timeout')throw Error('Timed out');},
  };
  await assert.rejects(executeMemberCreditBacking(args));
  const recorded=calls.filter(c=>c.name==='record_member_credit_backing_throttle');
  assert.equal(recorded.length,['write429','recordFailure'].includes(mode)?1:0,mode);
  if(recorded.length)assert.deepEqual(recorded[0].values,{
   p_tenant_id:'tenant',p_amendment_id:'amendment',p_actor_id:'actor',p_attempt:'retry-id',p_delay_seconds:90,
  });
  assert.equal(writes,mode==='cooldown'?0:1);
 }
});
