import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberAmendmentsHandler} from './member-amendments.js';
const memberId='10000000-0000-4000-8000-000000000001';
const requestId='10000000-0000-4000-8000-000000000002';
test('cancellation financial actions require finance administration and session-owned identity',async()=>{
 let context={isAuthenticated:true,tenantId:'tenant',tenantUserId:'actor'},admin=true,permitted=false;
 const calls=[];
 const finance=Object.fromEntries(['preview','confirm','recover'].map(name=>[name,async(...args)=>{calls.push({name,args});return {state:'pending'};}]));
 const handler=createMemberAmendmentsHandler({db:{},service:{},getContext:async()=>context,
  isAdmin:async()=>admin,hasFinance:async()=>permitted,cancellationFinanceService:finance});
 async function invoke(body){
  const res={code:200,setHeader(){},status(code){this.code=code;return this;},json(data){this.data=data;return this;}};
  await handler({method:'POST',body:{memberId,requestId,tenantId:'forged',actorId:'forged',...body}},res);return res;
 }
 assert.equal((await invoke({action:'preview_cancellation_finance',choice:'credit'})).code,200);
 assert.deepEqual(calls[0].args,[{tenantId:'tenant',memberId,actorId:'actor',actorKind:'admin'},requestId,{choice:'credit'}]);
 assert.equal((await invoke({action:'confirm_cancellation_finance',approve:false,expectedFingerprint:'a'.repeat(64)})).code,400);
 assert.equal(calls.length,1);
 assert.equal((await invoke({action:'confirm_cancellation_finance',approve:true,expectedFingerprint:'a'.repeat(64),choice:'credit',balance:999})).code,200);
 assert.deepEqual(calls[1].args[2],{approve:true,expectedFingerprint:'a'.repeat(64),choice:'credit'});
 await invoke({action:'recover_cancellation_finance',choice:'refund',approve:true,maxSteps:999,budgetMs:999999});
 assert.equal(calls[2].args.length,2);
 admin=false;assert.equal((await invoke({action:'recover_cancellation_finance'})).code,403);
 admin=true;context={...context,roleId:'restricted'};
 assert.equal((await invoke({action:'preview_cancellation_finance'})).code,403);
 assert.equal(calls.length,3);
 permitted=true;
 assert.equal((await invoke({action:'recover_cancellation_finance',requestId:'invalid'})).code,400);
 context={...context,tenantMismatch:true};
 assert.equal((await invoke({action:'recover_cancellation_finance'})).code,409);
 context={isAuthenticated:false};
 assert.equal((await invoke({action:'recover_cancellation_finance'})).code,401);
 assert.equal(calls.length,3);
});
test('financial history is bounded and scoped and failed reads are not empty histories',async()=>{
 const filters=[];let failure=false;
 const rows=Array.from({length:51},(_,n)=>({id:`10000000-0000-4000-8000-${String(n+1).padStart(12,'0')}`}));
 const db={from(table){assert.equal(table,'member_cancellation_request');return {
  select(){return this;},eq(k,v){filters.push([k,v]);return this;},not(k,op,v){filters.push([k,op,v]);return this;},
  order(k){assert.equal(k,'id');return this;},limit(n){assert.equal(n,51);return this;},
  gt(k,v){filters.push([k,v]);return this;},
  then(resolve){resolve(failure?{error:{message:'timeout'}}:{data:rows});},
 };}};
 const handler=createMemberAmendmentsHandler({db,service:{},getContext:async()=>({
  isAuthenticated:true,tenantId:'tenant',tenantUserId:'actor'}),isAdmin:async()=>true});
 async function invoke(){
  const res={code:200,setHeader(){},status(code){this.code=code;return this;},json(data){this.data=data;return this;}};
  await handler({method:'GET',query:{action:'cancellation_finances',memberId,after:requestId}},res);return res;
 }
 const res=await invoke();
 assert.equal(res.data.records.length,50);assert.equal(res.data.nextCursor,rows[49].id);
 assert.ok(filters.some(([k,v])=>k==='tenant_id'&&v==='tenant'));
 assert.ok(filters.some(([k,v])=>k==='member_id'&&v===memberId));
 assert.ok(filters.some(([k,op,v])=>k==='access_ended_at'&&op==='is'&&v===null));
 assert.ok(filters.some(([k,v])=>k==='id'&&v===requestId));
 failure=true;assert.equal((await invoke()).code,503);
});
