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
