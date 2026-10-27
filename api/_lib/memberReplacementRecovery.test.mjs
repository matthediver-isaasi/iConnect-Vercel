import test from 'node:test';
import assert from 'node:assert/strict';
import {runMemberReplacementRecovery} from './memberReplacementRecovery.js';
import {runMemberMonthlyRecovery} from './memberMonthlyFinalizationRecovery.js';
function fixture({kind='reconcile',applied=true,delivery={success:true,messageId:'mail-id'},failRead=false}={}){
 const finishes=[],sends=[],calls=[];
 const job={kind,tenant_id:'tenant',member_id:'member',execution_id:'execution',claim_token:'claim'};
 const db={
  async rpc(name,args){
   if(name==='pending_member_replacement_jobs'){assert.equal(args.p_kind,'all');return {data:[job]};}
   if(name==='claim_member_replacement_job')return {data:job};
   if(name==='finish_member_replacement_job'){finishes.push(args);return {data:{state:args.p_state}};}
   throw new Error(name);
  },
  from(table){const q={select(){return q},eq(){return q},async maybeSingle(){
   if(failRead)return {error:{code:'read_failure'}};
   return {data:table==='member'?{id:'member',email:'member@example.org'}:{
    member_id:'member',actor_id:'approver',authority_id:'authority',plan:{newTerm:{startDate:'2026-10-28',renewalDate:'2027-10-28'}}}};
  }};return q},
 };
 const service={async resume(actor,input){calls.push({actor,input});return {entitlementApplied:applied,nextAction:'await_payment',
  settlement:{state:'awaiting_payment',evidence:{verified:true,paymentUrl:'https://in.xero.com/invoice'}}};},
  async execute(){assert.fail('Recovery must never initiate a provider financial write')}};
 const run=()=>runMemberReplacementRecovery({db,service,sendEmail:async args=>{
  sends.push(args);if(delivery instanceof Error)throw delivery;return delivery;
 }});
 return {run,finishes,sends,calls};
}
test('replacement recovery applies only verified approved settlement and never starts a financial write',async()=>{
 const f=fixture();await f.run();
 assert.equal(f.finishes[0].p_state,'completed');assert.equal(f.sends.length,0);
 assert.equal(f.calls[0].actor.actorId,'approver');
});
test('replacement payment request uses a fresh verified invoice and canonical tenant member',async()=>{
 const f=fixture({kind:'payment',applied:false});await f.run();
 assert.equal(f.sends[0].tenantId,'tenant');assert.equal(f.sends[0].to,'member@example.org');
 assert.match(f.sends[0].html,/https:\/\/in.xero.com\/invoice/);
 assert.equal(f.finishes[0].p_state,'completed');
});
test('already paid replacement never sends an obsolete collection request',async()=>{
 const f=fixture({kind:'payment'});await f.run();assert.equal(f.sends.length,0);
 assert.equal(f.finishes[0].p_evidence.reason,'already_paid_and_applied');
});
test('unknown email delivery is uncertain, while definitive rejection permits a delayed retry',async()=>{
 for(const [delivery,state] of [[new Error('timeout'),'uncertain'],[{success:false},'uncertain'],[{success:false,notSubmitted:true},'pending']]){
  const f=fixture({kind:'confirmation',delivery});await f.run();
  assert.equal(f.sends.length,1);assert.equal(f.finishes[0].p_state,state);
  if(state==='pending')assert.equal(f.finishes[0].p_evidence.notSubmitted,true);
 }
});
test('no confirmation is sent before application and pre-send read failures remain safely retryable',async()=>{
 for(const options of [{kind:'confirmation',applied:false},{kind:'confirmation',failRead:true}]){
  const f=fixture(options);await f.run();
  assert.equal(f.sends.length,0);assert.equal(f.finishes[0].p_state,'pending');
  assert.equal(f.finishes[0].p_evidence.notSubmitted,true);
 }
});
test('slow monthly recovery cannot prevent the reserved replacement worker from starting',async()=>{
 let release;
 const gate=new Promise(resolve=>{release=resolve;});
 const started=[];
 const pending=runMemberMonthlyRecovery({db:{},budgetMs:1000,
  runFinalization:async()=>{started.push('monthly');await gate;return {};},
  runProvider:async()=>({}),runNotifications:async()=>({}),
  runReplacements:async options=>{started.push('replacement');assert.equal(options.budgetMs,250);return {enabled:true};},
 });
 try{
  await Promise.resolve();await Promise.resolve();
  assert.deepEqual(started,['monthly','replacement']);
 }finally{release();}
 assert.equal((await pending).replacements.enabled,true);
});
