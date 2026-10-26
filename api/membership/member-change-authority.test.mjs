import test from 'node:test';
test('monthly execution is selected from saved authority, requires migration readiness and cannot be selected by posted fields',async()=>{
 const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 let ready=true,called=0;
 const db={rpc:async()=>({data:ready}),from:()=>({select(){return this},eq(){return this},
   async maybeSingle(){return {data:{authority:{sourceSnapshot:{commitment_snapshot:{payment_frequency:'monthly'}}}}}}})};
 const handler=createMemberAmendmentsHandler({db,
   getContext:async()=>({isAuthenticated:true,tenantId:id(1),tenantUserId:id(2)}),
   isAdmin:async()=>true,hasFinance:async()=>true,
   monthlyExecutionService:{execute:async(actor)=>{called++;assert.equal(actor.tenantId,id(1));return {application:{operationId:id(4)}}}},
   executionService:{execute:async()=>{throw Error('Wrong upfront execution path')}}});
 const invoke=async()=>{
   const res={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this},json(data){this.body=data;return this}};
   await handler({method:'POST',body:{action:'execute_change',memberId:id(3),authorityId:id(4),frequency:'upfront',approve:true}},res);
   return res;
 };
 assert.ok((await invoke()).body.application);assert.equal(called,1);
 ready=false;assert.equal((await invoke()).statusCode,503);assert.equal(called,1);
});
import assert from 'node:assert/strict';
import { createMemberAmendmentsHandler } from './member-amendments.js';
const member='00000000-0000-4000-8000-000000000002';
test('authority entry points enforce admin finance access and use session tenant/actor',async()=>{
 let context={isAuthenticated:true,tenantId:'tenant',tenantUserId:'actor'};
 let calls=0;
 const handler=createMemberAmendmentsHandler({db:{},service:{},getContext:async()=>context,
   isAdmin:async()=>true,hasFinance:async()=>false,authorityService:{
    async preview(actor,selection){calls++;assert.equal(actor.tenantId,'tenant');assert.equal(actor.actorId,'actor');
      assert.equal(actor.memberId,member);return {fingerprint:'verified'};},
    async confirm(){calls++;return {id:'record'};},
    async recover(){calls++;return {id:'record'};}
   }});
 const invoke=async action=>{
  const res={code:200,setHeader(){},status(code){this.code=code;return this},json(body){this.body=body;return this}};
  await handler({method:'POST',body:{action,memberId:member,tenantId:'forged',actorId:'forged',selection:{}}},res);
  return res;
 };
 assert.equal((await invoke('preview_change')).body.fingerprint,'verified');
 assert.equal((await invoke('confirm_change')).body.executionEnabled,false);
 assert.equal((await invoke('recover_change')).body.record.id,'record');
 context={...context,tenantMismatch:true};assert.equal((await invoke('confirm_change')).code,409);
 context={...context,tenantMismatch:false,roleId:'role'};assert.equal((await invoke('preview_change')).code,403);
 context={isAuthenticated:false};assert.equal((await invoke('preview_change')).code,401);
 assert.equal(calls,3);
});
test('execution actions use the same tenant/admin/finance gate and authenticated actor',async()=>{
 let context={isAuthenticated:true,tenantId:'tenant',tenantUserId:'actor'},allowed=true,calls=0;
 const executionService=Object.fromEntries(['execute','resume'].map(name=>[name,async(actor)=>{
   calls++;assert.deepEqual(actor,{tenantId:'tenant',memberId:member,actorId:'actor',actorKind:'admin'});
   return {state:name};
 }]));
 const db={from(){return {select(){return this},eq(){return this},
   async maybeSingle(){return {data:{authority:{sourceSnapshot:{commitment_snapshot:{payment_frequency:'upfront'}}}}}}}}};
 const handler=createMemberAmendmentsHandler({db,service:{},executionService,getContext:async()=>context,
   isAdmin:async()=>allowed,hasFinance:async()=>false});
 const invoke=async action=>{
   const res={status(code){this.code=code;return this},json(body){this.body=body;return this},setHeader(){}};
   await handler({method:'POST',body:{action,memberId:member,authorityId:member,actorId:'forged',tenantId:'forged'}},res);return res;
 };
 assert.equal((await invoke('execute_change')).body.state,'execute');
 assert.equal((await invoke('resume_change')).body.state,'resume');
 allowed=false;assert.equal((await invoke('execute_change')).code,403);
 allowed=true;context={...context,roleId:'restricted'};assert.equal((await invoke('resume_change')).code,403);
 context={...context,tenantMismatch:true};assert.equal((await invoke('execute_change')).code,409);
 assert.equal(calls,2);
});
