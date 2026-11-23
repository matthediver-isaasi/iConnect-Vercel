import test from 'node:test';
import assert from 'node:assert/strict';
import {runFunnelReversalWorker} from './eventFunnelReversalWorker.js';
function fixture(){
  const calls=[];return {calls,tenantId:'tenant',operationId:'op',db:{rpc:async(name,args)=>{
    calls.push({name,args});return {data:name.endsWith('claim')?
      {id:'op',tenant_id:'tenant',order_id:'order',lease_id:'lease'}:true};}}};
}
test('only a claimed operation executes and its lease fences completion',async()=>{
  const f=fixture();const result=await runFunnelReversalWorker({...f,recover:async args=>{
    assert.equal(args.orderId,'order');
    return {outcomes:Object.fromEntries(['card','training','voucher','credit'].map(key=>[key,{status:'complete'}]))};
  }});
  assert.equal(result.status,'complete');assert.equal(f.calls[1].args.p_lease,'lease');
});
test('exceptions persist a retry instead of dropping the operation',async()=>{
  const f=fixture();assert.equal((await runFunnelReversalWorker({...f,recover:async()=>{throw new Error('Unavailable');}})).status,'retry');
  assert.deepEqual(Object.values(f.calls[1].args.p_outcomes),['retry','retry','retry','retry']);
});
test('an expired worker cannot claim completion',async()=>{
  const f=fixture(),rpc=f.db.rpc;f.db.rpc=async(name,args)=>name.endsWith('finish')?{data:false}:rpc(name,args);
  assert.equal((await runFunnelReversalWorker({...f,recover:async()=>({})})).status,'lease_lost');
});
test('idle and out-of-scope claims never execute recovery',async()=>{
  const f=fixture();f.db.rpc=async()=>({data:null});
  assert.equal((await runFunnelReversalWorker({...f,recover:async()=>assert.fail()})).status,'idle');
  f.db.rpc=async()=>({data:{id:'op',tenant_id:'other',order_id:'order',lease_id:'lease'}});
  await assert.rejects(runFunnelReversalWorker({...f,recover:async()=>assert.fail()}),/scope/);
});
test('new approval jobs require a separate cleanup outcome',async()=>{
  const f=fixture(),rpc=f.db.rpc;
  f.db.rpc=async(name,args)=>{const result=await rpc(name,args);if(name.endsWith('claim'))result.data.requires_cleanup=true;return result;};
  const result=await runFunnelReversalWorker({...f,recover:async()=>({
    outcomes:Object.fromEntries(['card','training','voucher','credit'].map(key=>[key,{status:'complete'}]))})});
  assert.equal(result.status,'retry');assert.equal(f.calls[1].args.p_outcomes.cleanup,'retry');
});
