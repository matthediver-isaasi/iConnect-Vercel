import test from 'node:test';
import assert from 'node:assert/strict';
import {approveFunnelCancellation,funnelCancellationOperationId} from './eventFunnelCancellationApproval.js';
const tenant='00000000-0000-4000-8000-000000000001',user='00000000-0000-4000-8000-000000000002';
function fixture(){
  const calls=[],requests=[{id:'request',tenant_id:tenant}],order='order';
  const f={calls,requests,ctx:{isAuthenticated:true,tenantId:tenant,tenantUserId:user},
    reviewerName:'Fixture reviewer',req:{headers:{'content-type':'application/json',host:'fixture.test',origin:'https://fixture.test'}},
    hasAdminAccess:async()=>true,hasFeatureAccess:async()=>true,
    prepare:async args=>({kind:'funnel',tenantId:tenant,orderId:order,operationId:args.operationId,requestIds:['request'],items:[]}),
    run:async args=>{calls.push(['run',args]);return {status:'complete'};}};
  f.db={rpc:async(name,args)=>{
    calls.push([name,args]);
    if(name==='event_funnel_consume_limit')return {data:true};
    assert.equal(name,'event_funnel_approve_cancellation');
    return {data:{id:args.p_id,tenant_id:tenant,order_id:order,cancelled_at:'accepted'}};
  }};
  return f;
}
test('request-set operation identity survives ordering and differs by tenant or subset',()=>{
  const id=funnelCancellationOperationId(tenant,['a','b']);
  assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(id,funnelCancellationOperationId(tenant,['b','a']));
  assert.notEqual(id,funnelCancellationOperationId(user,['a','b']));
  assert.notEqual(id,funnelCancellationOperationId(tenant,['a']));
});
test('legacy requests do not enter the shared refund worker',async()=>{
  const f=fixture();f.prepare=async()=>({kind:'legacy'});
  assert.equal(await approveFunnelCancellation(f),null);assert.deepEqual(f.calls,[]);
});
test('approval freezes reviewer authority and executes only the accepted durable operation',async()=>{
  const f=fixture(),result=await approveFunnelCancellation({...f,suppressEmails:true,reviewNotes:'Fixture'});
  assert.equal(result.recovery,'complete');assert.equal(result.reviewedAt,'accepted');
  assert.equal(f.calls[1][1].p_authority.actor,`user:${user}`);
  assert.equal(f.calls[1][1].p_authority.suppressEmails,true);
  assert.equal(f.calls[2][1].operationId,result.operationId);
});
test('recovery outage never turns accepted approval into a legacy cancellation retry',async()=>{
  const f=fixture();f.run=async()=>{throw new Error('Unavailable');};
  const result=await approveFunnelCancellation(f);assert.equal(result.recovery,'queued');
  assert.equal(f.calls.filter(([name])=>name==='event_funnel_approve_cancellation').length,1);
});
test('unauthorized, cross-site and unsupported choices cannot authorize refunds',async()=>{
  for(const overrides of [
    {ctx:{isAuthenticated:false}}, {hasAdminAccess:async()=>false},
    {ctx:{isAuthenticated:true,tenantId:tenant,memberId:user},hasFeatureAccess:async()=>false},
    {req:{headers:{'content-type':'application/json','sec-fetch-site':'cross-site'}}},
    {options:{discountCodeReplacement:true}},
    {suppressEmails:'yes'}, {requests:[{id:'foreign',tenant_id:user}]},
  ]){
    const f=fixture();await assert.rejects(approveFunnelCancellation({...f,...overrides}));
    assert.equal(f.calls.length,0);
  }
});
test('rate limiting and rejected approval do not run recovery',async()=>{
  for(const [data,error] of [[false,null],[null,{code:'PT409'}]]){
    const f=fixture();f.db.rpc=async name=>name==='event_funnel_consume_limit'?{data:data===false?false:true}:{error};
    await assert.rejects(approveFunnelCancellation(f));
    assert.deepEqual(f.calls,[]);
  }
});
