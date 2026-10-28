import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberAmendmentsHandler} from './member-amendments.js';
const memberId='11111111-1111-4111-8111-111111111111';
function fixture({admin=true,finance=true}={}){
 const calls=[];
 const service=Object.fromEntries(['records','preview','confirm','recover','recoverKey','withdraw']
  .map(method=>[method,async(...args)=>{calls.push({method,args});return {record:{id:'request'}};}]));
 const handler=createMemberAmendmentsHandler({db:{},service:{},cancellationRequestsService:service,
  getContext:async()=>({isAuthenticated:true,tenantId:'owned-tenant',tenantUserId:'signed-in-actor',roleId:'finance-role'}),
  isAdmin:async()=>admin,hasFinance:async()=>finance});
 return {calls,async call(action,body={},method='POST'){
  const res={code:200,setHeader(){},status(n){this.code=n;return this},json(body){this.body=body;return this}};
  await handler({method,query:{action,memberId,...body},body:{action,memberId,...body}},res);return res;
 }};
}
test('cancellation routes use the authenticated finance actor, never posted ownership',async()=>{
 for(const [action,method,input,http] of [
  ['cancellation_requests','records',{},'GET'],['preview_cancellation','preview',{selection:{reason:'Requested'}},'POST'],
  ['confirm_cancellation','confirm',{approve:true},'POST'],['recover_cancellation','recover',{id:'request'},'POST'],
  ['recover_cancellation','recoverKey',{key:'key',fingerprint:'a'.repeat(64)},'POST'],
  ['withdraw_cancellation','withdraw',{id:'request',reason:'Continue'},'POST'],
 ]){
  const f=fixture(),res=await f.call(action,{...input,actorId:'attacker',tenantId:'foreign'},http);
  assert.equal(res.code,200);assert.equal(f.calls[0].method,method);
  assert.deepEqual(f.calls[0].args[0],{tenantId:'owned-tenant',memberId,actorId:'signed-in-actor',actorKind:'admin'});
 }
});
test('cancellation routes require admin and finance access and valid member identifiers',async()=>{
 for(const settings of [{admin:false},{finance:false}]){
  const f=fixture(settings);assert.equal((await f.call('confirm_cancellation')).code,403);assert.equal(f.calls.length,0);
 }
 const f=fixture();
 assert.equal((await f.call('preview_cancellation',{memberId:'invalid'})).code,400);
 assert.equal((await f.call('cancellation_requests')).code,405);
 assert.equal((await f.call('confirm_cancellation',{},'GET')).code,405);
 assert.equal(f.calls.length,0);
});
