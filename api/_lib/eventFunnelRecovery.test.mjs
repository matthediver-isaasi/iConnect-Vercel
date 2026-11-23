import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverEventFunnelOrders,deliverEventFunnelOrders } from './eventFunnelRecovery.js';

function queue(rows,kind='recovery') {
  const calls=[];
  return {calls,db:{rpc:async(name,args)=>{
    calls.push([name,args]);
    if(name===`event_funnel_${kind}_claim`) return {data:rows.length?[rows.shift()]:[]};
    if(name===`event_funnel_${kind}_finish`) return {data:true};
    throw new Error(name);
  }}};
}
const row=(extra={})=>({id:'order',tenant_id:'tenant',lease_token:'token',payment_method:'card',
  snapshot:{reservationExpiresAt:'2030-01-01T00:00:00Z'},...extra});
test('unstarted live card checkouts are not turned into provider requests by a worker',async()=>{
  const q=queue([row()]);
  const result=await recoverEventFunnelOrders({db:q.db,now:()=>0,paymentFor:async()=>({
    service:{reconcile(){throw new Error('must not initiate');}},store:{},
  })});
  assert.deepEqual(result,{checked:1,confirmed:0,cancelled:0,pending:1,retry:0});
  assert.equal(q.calls[1][0],'event_funnel_recovery_finish');
});
test('expired payment reconciliation uses the original bound intent before cancellation',async()=>{
  const original=row({payment_request:{amount:100},snapshot:{reservationExpiresAt:'1970-01-01T00:00:00Z'}});
  const q=queue([original]),calls=[];
  const current={...original,payment_intent_id:'pi_original'};
  const result=await recoverEventFunnelOrders({db:q.db,now:()=>100000,paymentFor:async()=>({
    service:{reconcile:async()=>{calls.push('reconcile');return {state:'requires_action'};},
      cancel:async order=>{assert.equal(order.payment_intent_id,'pi_original');calls.push('cancel');return {state:'cancelled'};}},
    store:{read:async id=>{assert.equal(id,'order');return current;}},
  })});
  assert.deepEqual(calls,['reconcile','cancel']);
  assert.equal(result.cancelled,1);
});
test('provider or registration failures remain retryable and do not prevent another order recovering',async()=>{
  const q=queue([row({id:'bad',payment_method:'free'}),row({id:'good',payment_method:'account'})]);
  const result=await recoverEventFunnelOrders({db:q.db,paymentFor:async()=>({
    service:{reconcile:async order=>{if(order.id==='bad') throw new Error('private provider detail');return {state:'confirmed'};}},store:{},
  })});
  assert.equal(result.retry,1);assert.equal(result.confirmed,1);
  assert.equal(JSON.stringify(q.calls).includes('private provider detail'),false);
});
test('payment recovery cannot claim a new item after its budget expires',async()=>{
  const q=queue([row({payment_method:'free'}),row()]);
  let time=0;
  const result=await recoverEventFunnelOrders({db:q.db,now:()=>time,budgetMs:2000,paymentFor:async()=>({
    service:{reconcile:async()=>{time=3000;return {state:'confirmed'};}},store:{},
  })});
  assert.equal(result.checked,1);
  assert.equal(q.calls.filter(([name])=>name.endsWith('_claim')).length,1);
});
test('delivery requires explicit success; transient errors never erase confirmed registrations',async()=>{
  const q=queue([{tenant_id:'t',order_id:'a',lease_token:'1'},{tenant_id:'t',order_id:'b',lease_token:'2'}],'delivery');
  const result=await deliverEventFunnelOrders({db:q.db,kind:'invoices',deliver:async job=>{
    if(job.order_id==='a') throw new Error('private accounting detail');
    return {status:'delivered'};
  }});
  assert.deepEqual(result,{checked:2,delivered:1,retry:1,needs_review:0});
  assert.deepEqual(q.calls.filter(([name])=>name.endsWith('_finish')).map(([,args])=>args.p_status),['retry','delivered']);
  assert.equal(JSON.stringify(q.calls).includes('private accounting detail'),false);
});
test('unconfirmed delivery and stale lease completion are not reported as success',async()=>{
  const q=queue([{tenant_id:'t',order_id:'a',lease_token:'1'}],'delivery');
  const result=await deliverEventFunnelOrders({db:q.db,kind:'confirmations',deliver:async()=>undefined});
  assert.equal(result.retry,1);
  const broken={rpc:async name=>name.endsWith('_claim')?{data:[row({order_id:'order'})]}:{data:false}};
  await assert.rejects(deliverEventFunnelOrders({db:broken,kind:'invoices',deliver:async()=>({status:'delivered'})}),/lease completion/);
});
