import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberCancellationProvider} from './memberCancellationProvider.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(provider='stripe'){
 const a={tenantId:id(1),memberId:id(2),agreementId:id(3),provider,
  environment:provider==='stripe'?'test':'sandbox',subscriptionId:'sub',payerId:'payer',
  scheduleId:'schedule',mandateId:'mandate'};
 let stopped=false,lost=false;const writes=[];
 const stripe={
  subscriptions:{retrieve:async()=>({id:'sub',customer:'payer',livemode:false,
   metadata:{tenant_id:id(1),member_id:id(2),agreement_id:id(3),kind:'monthly_card'},
   status:stopped?'canceled':'active',schedule:'schedule'})},
  subscriptionSchedules:{
   retrieve:async()=>({id:'schedule',customer:'payer',subscription:'sub',livemode:false,status:stopped?'canceled':'active'}),
   cancel:async(...args)=>{writes.push(args);stopped=true;if(lost)throw Error('response lost');},
  },
 };
 const gc={getSubscription:async()=>({id:'sub',links:{mandate:'mandate'},status:stopped?'cancelled':'active'}),
  getMandate:async()=>({id:'mandate',links:{customer:'payer'},status:'active'}),
  cancelSubscription:async(...args)=>{writes.push(args);stopped=true;if(lost)throw Error('response lost');},
  cancelMandate:()=>assert.fail('Never cancel the shared mandate'),
 };
 const service=createMemberCancellationProvider({
  getStripe:async(tenant,mode)=>{assert.equal(tenant,id(1));assert.equal(mode,'test');return stripe;},
  getGc:async(tenant,mode)=>{assert.equal(tenant,id(1));assert.equal(mode,'sandbox');return gc;},
 });
 return {a,service,writes,stripe,gc,loseResponse(){lost=true;},
  claim:p=>({id:id(4),claim_token:id(5),state:'claimed',fingerprint:p.fingerprint,tenant_id:id(1),member_id:id(2)})};
}
for(const provider of ['stripe','gocardless']){
 test(`${provider}: recovery reads only, submission needs a claim and does not cancel mandates`,async()=>{
  const f=fixture(provider),p=await f.service.prepare(f.a);
  assert.equal((await f.service.reconcile(p)).state,'active');
  await assert.rejects(f.service.submitReservedStop(p,null),/claim/);
  assert.equal(f.writes.length,0);
  const stopped=await f.service.submitReservedStop(p,f.claim(p));
  assert.equal(stopped.state,'stopped');
  assert.equal(stopped.existingPaymentsRequireReconciliation,true);
  await f.service.reconcile(p);
  assert.equal(f.writes.length,1);
  if(provider==='stripe')assert.deepEqual(f.writes[0],['schedule',
   {invoice_now:false,prorate:false},{idempotencyKey:`member-cancel:${id(4)}`}]);
 });
 test(`${provider}: lost write responses recover without another cancellation`,async()=>{
  const f=fixture(provider),p=await f.service.prepare(f.a);f.loseResponse();
  assert.equal((await f.service.submitReservedStop(p,f.claim(p))).state,'uncertain');
  assert.equal((await f.service.reconcile(p)).state,'stopped');
  assert.equal(f.writes.length,1);
 });
}
test('foreign claims and changed approved snapshots cannot submit',async()=>{
 const f=fixture(),p=await f.service.prepare(f.a);
 await assert.rejects(f.service.submitReservedStop(p,{...f.claim(p),tenant_id:id(8)}),/claim/);
 await assert.rejects(f.service.reconcile({...p,authority:{...p.authority,subscriptionId:'other'}}),/snapshot/);
 assert.equal(f.writes.length,0);
});
test('fresh ownership is checked before a claimed write',async()=>{
 const f=fixture(),p=await f.service.prepare(f.a);
 f.stripe.subscriptions.retrieve=async()=>({id:'sub',customer:'foreign'});
 await assert.rejects(f.service.submitReservedStop(p,f.claim(p)),/ownership/);
 assert.equal(f.writes.length,0);
});
