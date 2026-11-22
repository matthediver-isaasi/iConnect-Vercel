import test from 'node:test';
import assert from 'node:assert/strict';
import { executeLifecycleTransition } from './memberLifecycleExecution.js';
const memberId='33333333-3333-4333-8333-333333333333';
const detail={revision:1,state:'former',blockers:[],sourceStamp:'a'.repeat(32),proposal:{action:'archive'}};
const args={tenantId:'tenant',actor:'member:reviewer',saved:{revision:2,policy:{}},
  body:{memberId,expectedRevision:1,reason:'Documented evidence',action:'archive'}};
test('transition binds fresh evidence to tenant, actor, policy and record revisions', async()=>{
  let sent;
  const result=await executeLifecycleTransition({rpc:async(name,body)=>{sent={name,body};return{data:{memberId}};}},args,{detail:async()=>detail});
  assert.equal(result.memberId,memberId);
  assert.equal(sent.body.p_stamp,detail.sourceStamp);
  assert.equal(sent.body.p_policy_revision,2);
  assert.equal(sent.body.p_actor,'member:reviewer');
});
test('changed evidence, obligations, stale revisions and unsupported actions never write',async()=>{
  const db={rpc:async()=>assert.fail('must not mutate')};
  for(const changed of [{...detail,revision:2},{...detail,blockers:['unpaid_invoice']},
    {...detail,proposal:{action:'none'}}]){
    await assert.rejects(executeLifecycleTransition(db,args,{detail:async()=>changed}),e=>e.status===409);
  }
  await assert.rejects(executeLifecycleTransition(db,{...args,body:{...args.body,action:'delete'}},{detail:async()=>detail}),e=>e.status===400);
});
