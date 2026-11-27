import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberAmendmentsHandler} from './member-amendments.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

test('Direct Debit self-cancellation is scoped to the signed-in member only',async()=>{
 let context={isAuthenticated:true,tenantId:id(1),memberId:id(2)};
 const calls=[];
 const service=Object.fromEntries(['status','preview','confirm','recover'].map(name=>[
  name,async(...args)=>{calls.push({name,args});return {ok:true};}]));
 const handler=createMemberAmendmentsHandler({db:{},getContext:async()=>context,isAdmin:async()=>false,
  hasFinance:async()=>false,memberDdCancellationService:service});
 async function invoke(action,method='POST',input={}){
  const res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(value){this.value=value;return this;}};
  const body={action,tenantId:id(99),actorId:id(99),...input};
  await handler({method,body,query:body},res);return res;
 }
 assert.equal((await invoke('member_dd_cancellation_status','GET')).statusCode,200);
 assert.deepEqual(calls[0].args[0],{tenantId:id(1),memberId:id(2),actorId:id(2),actorKind:'member'});
 assert.equal((await invoke('member_dd_cancellation_status','POST')).statusCode,405);
 assert.equal((await invoke('member_dd_cancellation_confirm','GET')).statusCode,405);
 // Another member's id is refused, never silently substituted.
 assert.equal((await invoke('member_dd_cancellation_preview','POST',{memberId:id(9),reason:'x'})).statusCode,403);
 await invoke('member_dd_cancellation_confirm','POST',{idempotencyKey:'member-dd-cancel:abc',fingerprint:'f',reason:'Cost',approve:true});
 assert.deepEqual(calls.at(-1).args[1],{key:'member-dd-cancel:abc',fingerprint:'f',reason:'Cost',approve:true});
 assert.equal(calls.at(-1).args[0].actorKind,'member');
 await invoke('member_dd_cancellation_recover','POST',{id:id(5)});
 assert.equal(calls.at(-1).name,'recover');
 // Tenant administrator accounts without a member record cannot use the member route.
 context={isAuthenticated:true,tenantId:id(1),tenantUserId:id(8)};
 assert.equal((await invoke('member_dd_cancellation_preview')).statusCode,403);
 context={isAuthenticated:false};
 assert.equal((await invoke('member_dd_cancellation_status','GET')).statusCode,401);
 assert.equal(calls.length,3);
});

test('service errors surface their status without leaking internals',async()=>{
 const handler=createMemberAmendmentsHandler({db:{},getContext:async()=>({isAuthenticated:true,tenantId:id(1),memberId:id(2)}),
  memberDdCancellationService:{async preview(){throw Object.assign(new Error('Not eligible yet'),{status:409});}}});
 const res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(value){this.value=value;return this;}};
 await handler({method:'POST',body:{action:'member_dd_cancellation_preview',reason:'x'}},res);
 assert.equal(res.statusCode,409);assert.equal(res.value.error,'Not eligible yet');
});
