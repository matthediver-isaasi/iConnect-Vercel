import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverFunnelCancellationCleanup} from './eventFunnelCancellationCleanup.js';
const context={order:{id:'order',tenant_id:'tenant'},operation:{id:'operation',order_id:'order',tenant_id:'tenant',lease_id:'lease'}};
const notifications=async()=>({status:'complete'});
const providers=async()=>({status:'complete'});
const creditEmails=async()=>({status:'complete'});
test('cleanup requires a lease and validates the database completion receipt',async()=>{
  const db={rpc:async(name,args)=>{
    assert.equal(name,'event_funnel_cancellation_cleanup_quiet');
    assert.deepEqual(args,{p_tenant:'tenant',p_order:'order',p_id:'operation',p_lease:'lease'});
    return {data:{operationId:'operation',status:'complete',receipt:{version:1}}};
  }};
  assert.deepEqual(await recoverFunnelCancellationCleanup({db,context,notifications,providers,creditEmails}),{status:'complete'});
  assert.deepEqual(await recoverFunnelCancellationCleanup({db:{},context:{...context,operation:{}}}),{status:'needs_review'});
});
test('missing migration is visible and foreign or unsupported receipts fail closed',async()=>{
  assert.deepEqual(await recoverFunnelCancellationCleanup({context,notifications,providers,creditEmails,db:{rpc:async()=>({error:{code:'42883'}})}}),
    {status:'needs_review'});
  for(const data of [{status:'complete',operationId:'foreign',receipt:{version:1}},
    {status:'complete',operationId:'operation'}, {status:'unknown',operationId:'operation'}])
    await assert.rejects(recoverFunnelCancellationCleanup({context,notifications,providers,creditEmails,db:{rpc:async()=>({data})}}));
});
test('provider and notification failures do not starve credit email recovery',async()=>{
  const calls=[];
  const result=await recoverFunnelCancellationCleanup({db:{},context,
    notifications:async()=>{calls.push('notification');throw new Error('Unknown send');},
    providers:async()=>{calls.push('provider');return {status:'needs_review'};},
    creditEmails:async()=>{calls.push('credit-email');return {status:'complete'};}});
  assert.deepEqual(calls,['notification','provider','credit-email']);assert.equal(result.status,'retry');
});
