import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberCancellationExecution} from './memberCancellationExecution.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(){
 const context={tenantId:id(1),memberId:id(2),actorId:id(3),actorKind:'admin'};
 const row={id:id(4),tenant_id:id(1),member_id:id(2),state:'pending',fingerprint:'fingerprint',
  prepared:{fingerprint:'fingerprint',authority:{subscriptionId:'sub'}}};
 let writes=0,reads=0,lose=false,stopped=false;
 const db={from(){
  const q={select(){return q},eq(){return q},maybeSingle:async()=>({data:{...row}})};return q;
 },async rpc(name,args){
  if(name==='claim_member_cancellation_provider_stop'){
   const claimed=row.state==='pending';
   if(claimed){row.state='claimed';row.claim_token=id(5);}
   return {data:{claimed,operation:{...row}}};
  }
  assert.equal(name,'record_member_cancellation_provider_stop');
  assert.equal(args.p_claim_token,row.claim_token);
  row.state=args.p_evidence.state==='stopped'?'stopped':'uncertain';
  return {data:{...row}};
 }};
 const service=createMemberCancellationExecution({db,provider:{
  reconcile:async()=>{reads++;return {state:stopped?'stopped':'active',subscriptionId:'sub'};},
  submitReservedStop:async()=>{writes++;stopped=true;
   if(lose)throw Error('response lost');return {state:'stopped',subscriptionId:'sub'};
  },
 }});
 return {service,context,row,get writes(){return writes},get reads(){return reads},loseResponse(){lose=true;}};
}
test('recovery cannot initiate a pending cancellation and execution claims once',async()=>{
 const f=fixture();
 await f.service.recover(f.context,id(4));assert.equal(f.writes,0);
 assert.equal((await f.service.execute(f.context,id(4))).state,'stopped');
 await f.service.execute(f.context,id(4));assert.equal(f.writes,1);
});
test('lost response retains claim and recovers without another destructive call',async()=>{
 const f=fixture();f.loseResponse();
 assert.equal((await f.service.execute(f.context,id(4))).state,'uncertain');
 assert.equal((await f.service.recover(f.context,id(4))).state,'stopped');
 assert.equal(f.writes,1);assert.equal(f.reads,1);
});
test('member actors and mismatched stored owners cannot execute',async()=>{
 const f=fixture();
 await assert.rejects(f.service.execute({...f.context,actorKind:'member'},id(4)));
 f.row.member_id=id(9);
 await assert.rejects(f.service.recover(f.context,id(4)));
 assert.equal(f.writes,0);
});
