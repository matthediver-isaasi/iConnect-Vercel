import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberAmendmentsHandler} from './member-amendments.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('member endpoints own identity; staff review requires separate finance authority',async()=>{
 let context={isAuthenticated:true,tenantId:id(1),memberId:id(2)},admin=false,finance=false;
 const calls=[];
 const service=Object.fromEntries(['availability','contextInfo','preview','submit','recover','records','review'].map(name=>[
  name,async(...args)=>{calls.push({name,args});return {};}]));
 const handler=createMemberAmendmentsHandler({db:{},getContext:async()=>context,isAdmin:async()=>admin,
  hasFinance:async()=>finance,memberRequestsService:service});
 async function invoke(action,method='POST',input={}){
  const res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(value){this.value=value;return this;}};
  const body={action,formId:id(3),memberId:id(99),actorId:id(99),tenantId:id(99),...input};
  await handler({method,body,query:body},res);return res;
 }
 assert.equal((await invoke('member_change_preview')).statusCode,200);
 assert.equal(calls[0].args[0].memberId,id(2));
 assert.equal(calls[0].args[0].actorId,id(2));
 assert.equal(calls[0].args[0].tenantId,id(1));
 assert.equal((await invoke('member_change_availability','GET')).statusCode,200);
 assert.equal(calls.at(-1).name,'availability');
 assert.equal((await invoke('member_change_availability','POST')).statusCode,405);
 assert.equal((await invoke('member_change_submit','GET')).statusCode,405);
 assert.equal((await invoke('review_member_change_request')).statusCode,403);
 admin=true;context.roleId=id(5);
 assert.equal((await invoke('review_member_change_request')).statusCode,403);
 finance=true;
 assert.equal((await invoke('review_member_change_request','POST',{decision:'withdraw'})).statusCode,400);
 assert.equal((await invoke('review_member_change_request','POST',{decision:'approve',id:id(6),reason:'Approved'})).statusCode,200);
 assert.equal(calls.at(-1).args[0].actorKind,'admin');
 assert.equal(calls.at(-1).args[1].action,'approve');
 await invoke('member_change_withdraw','POST',{decision:'approve',id:id(6)});
 assert.equal(calls.at(-1).args[1].action,'withdraw');
 context={isAuthenticated:true,tenantId:id(1),tenantUserId:id(8)};
 assert.equal((await invoke('member_change_preview')).statusCode,403);
 context={isAuthenticated:false};
 assert.equal((await invoke('member_change_preview')).statusCode,401);
});
