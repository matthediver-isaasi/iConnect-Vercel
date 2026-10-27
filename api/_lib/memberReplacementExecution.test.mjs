import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberReplacementExecutionService} from './memberReplacementExecution.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(){
 const context={tenantId:id(1),memberId:id(2),actorId:id(3),actorKind:'admin'};
 const input={authorityId:id(4),choice:'collect',approve:true,reason:'Approved'};
 const execution={id:id(5),authority_id:id(4),tenant_id:id(1),member_id:id(2),
  plan:{choice:'collect',sourcePaymentIds:['cash'],steps:[
   {key:'new_invoice',providerTenantId:'books',sourceInvoiceId:'old',contactId:'payer'},
   {key:'transfer_note',providerTenantId:'books',sourceInvoiceId:'old',contactId:'payer'}]}};
 const steps=execution.plan.steps.map((s,position)=>({step_key:s.key,position,state:'pending'}));
 const recorded=new Map(),calls=[];let submitCount=0,failWrite=false;
 const db={from(table){
  const q={select(){return q},eq(){return q},maybeSingle:async()=>({data:table==='member_replacement_application'?null:
   table==='member_change_authority'?{authority:{sourceSnapshot:{},calculation:{currency:'GBP',finance:{original:{grossMinor:10000}}},fundingEvidence:{providerEvidence:{}}}}:execution}),
   order:async()=>({data:steps.map(s=>({...s}))})};return q;
 },async rpc(name,args){
  calls.push(name);
  const row=steps.find(s=>s.step_key===args.p_step_key);
  if(name==='claim_member_replacement_step'){
   if(row.state!=='pending')return {data:{claimed:false,step:{...row}}};
   row.state='claimed';row.claim_token=id(8);return {data:{claimed:true,step:{...row}}};
  }
  if(name==='observe_member_replacement_step'){row.state='observed';return {data:{...row}};}
  if(name==='fail_member_replacement_step'){row.state='uncertain';return {data:{...row}};}
  assert.fail(name);
 }};
 const service=createMemberReplacementExecutionService({db,
  settlementInspector:async()=>({state:'awaiting_payment',evidence:{kind:'awaiting_replacement_payment'}}),
  finance:{verifyOriginal:async()=>({sourceInvoiceId:'old',contactId:'payer',originalPaymentIds:['cash']}),
   accountingClient:async()=>({xeroTenantId:'books',request:()=>assert.fail('mock adapter handles requests')})},
  accountingFactory:()=>({
   inspect:async s=>recorded.get(s.key)||{state:'absent'},
   submitReservedStep:async s=>{
    submitCount++;const result={state:'observed',id:s.key};recorded.set(s.key,result);
    if(failWrite){failWrite=false;throw Error('response lost');}
    return result;
   },
  }),
 });
 return {context,input,service,steps,calls,recorded,get submissions(){return submitCount},
  loseResponse(){failWrite=true}};
}
test('resume never creates documents; explicit execution claims each step once',async()=>{
 const f=fixture();
 assert.equal((await f.service.resume(f.context,f.input)).nextAction,'execute');
 assert.equal(f.submissions,0);
 const result=await f.service.execute(f.context,f.input);
 assert.equal(result.accountingComplete,true);
 assert.equal(result.entitlementApplied,false);
 assert.equal(result.nextAction,'await_payment');
 assert.equal(f.submissions,2);
 await f.service.execute(f.context,f.input);
 assert.equal(f.submissions,2);
});
test('lost write response recovers by reading and does not automatically start the next step',async()=>{
 const f=fixture();f.loseResponse();
 await assert.rejects(f.service.execute(f.context,f.input),/response lost/);
 assert.equal(f.steps[0].state,'uncertain');
 assert.equal((await f.service.resume(f.context,f.input)).nextAction,'execute');
 assert.equal(f.submissions,1);
 await f.service.execute(f.context,f.input);
 assert.equal(f.submissions,2);
});
test('a missing document after an unknown claim never grants another financial write',async()=>{
 const f=fixture();f.steps[0].state='claimed';
 assert.equal((await f.service.resume(f.context,f.input)).nextAction,'reconcile');
 await f.service.execute(f.context,f.input);
 assert.equal(f.submissions,0);
});
test('approval and financial treatment cannot be changed through recovery or replay',async()=>{
 const f=fixture();
 await assert.rejects(f.service.execute(f.context,{...f.input,approve:false}),/approval/);
 await assert.rejects(f.service.execute(f.context,{...f.input,choice:'credit'}),/locked/);
 await assert.rejects(f.service.resume({...f.context,actorKind:'member'},f.input),/administrator/);
 assert.equal(f.submissions,0);
});
