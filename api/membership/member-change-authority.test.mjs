import test from 'node:test';
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
 const handler=createMemberAmendmentsHandler({db:{},service:{},executionService,getContext:async()=>context,
   isAdmin:async()=>allowed,hasFinance:async()=>false});
 const invoke=async action=>{
   const res={status(code){this.code=code;return this},json(body){this.body=body;return this},setHeader(){}};
   await handler({method:'POST',body:{action,memberId:member,actorId:'forged',tenantId:'forged'}},res);return res;
 };
 assert.equal((await invoke('execute_change')).body.state,'execute');
 assert.equal((await invoke('resume_change')).body.state,'resume');
 allowed=false;assert.equal((await invoke('execute_change')).code,403);
 allowed=true;context={...context,roleId:'restricted'};assert.equal((await invoke('resume_change')).code,403);
 context={...context,tenantMismatch:true};assert.equal((await invoke('execute_change')).code,409);
 assert.equal(calls,2);
});
