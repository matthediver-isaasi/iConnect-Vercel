test('complete cancellation worker can resume a due lifecycle without starting unapproved finances',async()=>{
 const {runMemberCancellationRecovery}=await import('./memberCancellationFinanceWorker.js');
 const calls=[],record={id:'request',tenant_id:'tenant',member_id:'member',actor_id:'actor',authority:{}};
 const jobs=[{id:'job',request_id:'request',kind:'lifecycle',claim_token:'lease'}];
 const db={async rpc(name,args){
  calls.push([name,args]);
  if(name==='claim_member_cancellation_jobs')return {data:jobs.splice(0,1)};
  if(name==='finish_member_cancellation_job')return {data:true};
  throw Error(name);
 },from(){const q={select(){return q},eq(){return q},async maybeSingle(){return {data:record}}};return q;}};
 const result=await runMemberCancellationRecovery({db,requests:{async recover(context,id){
  assert.equal(context.memberId,'member');assert.equal(id,'request');
  return {record:{...record,access_ended_at:'2026-10-28T00:00:00Z'},provider:null};
 }},finance:{recover(){throw Error('Financial approval is separate');}},notify:{}});
 assert.equal(result.outcomes[0].state,'done');
 assert.equal(calls.filter(c=>c[0]==='claim_member_cancellation_jobs').length,1);
});
import test from 'node:test';
import assert from 'node:assert/strict';
import {runMemberCancellationFinanceRecovery} from './memberCancellationFinanceWorker.js';
import {createMemberAmendmentRecoveryHandler} from '../cron/member-amendments.js';
test('financial worker cannot run lifecycle jobs or originate financial approvals',async()=>{
 const jobs=[{id:'job',request_id:'request',claim_token:'token',kind:'lifecycle'}],calls=[];
 const db={rpc:async(name,args)=>{
  calls.push([name,args]);
  if(name==='claim_member_cancellation_finance_jobs')return {data:jobs.splice(0,1)};
  if(name==='finish_member_cancellation_job')return {data:true};
  throw Error('Unexpected RPC');
 },from(){throw Error('Forbidden lifecycle record access');}};
 const result=await runMemberCancellationFinanceRecovery({db,finance:{recover(){throw Error('Must not run');}},notify:{}});
 assert.equal(result.outcomes[0].state,'pending');
 assert.equal(calls.find(c=>c[0]==='finish_member_cancellation_job')[1].p_state,'pending');
 assert.equal(calls.some(c=>c[0]==='claim_member_cancellation_jobs'),false);
});
test('zero-budget worker claims nothing',async()=>{
 const result=await runMemberCancellationFinanceRecovery({db:{},budgetMs:0,finance:{},notify:{}});
 assert.equal(result.timedOut,true);
});
test('cron denies blank credentials and isolates cancellation worker failures',async()=>{
 const calls=[];let secret='';
 const handler=createMemberAmendmentRecoveryHandler({db:{},secret:()=>secret,
  run:async()=>{calls.push('legacy');return {processed:2};},
  runExecutions:async()=>({}),runMonthly:async()=>({}),
  runCancellations:async({budgetMs})=>{calls.push('cancellation');assert.ok(budgetMs>0&&budgetMs<=5000);throw Error('offline');}});
 const invoke=async authorization=>{
  const res={code:200,setHeader(){},status(code){this.code=code;return this;},json(data){this.data=data;return this;}};
  await handler({method:'POST',headers:{authorization}},res);return res;
 };
 assert.equal((await invoke('Bearer ')).code,401);assert.deepEqual(calls,[]);
 secret='   ';assert.equal((await invoke('Bearer    ')).code,401);assert.deepEqual(calls,[]);
 secret='test-secret';assert.equal((await invoke('Bearer wrong')).code,401);
 const result=await invoke('Bearer test-secret');
 assert.equal(result.code,200);assert.equal(result.data.processed,2);
 assert.equal(result.data.cancellationFinanceRecovery.error,'cancellation_finance_recovery_failed');
 assert.deepEqual(calls,['legacy','cancellation']);
});
