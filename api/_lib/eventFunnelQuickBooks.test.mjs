import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverFunnelQuickBooks} from './eventFunnelQuickBooks.js';
import {assertAccountingEventSource,linkAccountingEventSource,isAccountingEventSource} from './accountingEventSource.js';
const job={tenant_id:'tenant',order_id:'order',lease_token:'lease'};
test('QuickBooks handoff processes only the original request and confirms durable links afterwards',async()=>{
  const calls=[];let count=0;
  const db={rpc:async(name,args)=>{calls.push([name,args]);return {data:{requestId:'original',status:count++?'complete':'pending'}};}};
  const result=await deliverFunnelQuickBooks({db,job,key:'key',deadlineAt:12345,
    processRequest:async input=>{calls.push(['process',input.requestId]);assert.equal(input.deadlineAt,12345);}});
  assert.equal(result.status,'complete');
  assert.deepEqual(calls.map(row=>row[0]),['event_funnel_quickbooks_handoff','process','event_funnel_quickbooks_handoff']);
  assert.deepEqual(calls[0][1],{p_tenant:'tenant',p_order:'order',p_token:'lease',p_key:'key'});
});
test('existing completion/review does not repeat provider work; queue failure preserves the original request',async()=>{
  for(const status of ['complete','needs_review']) {
    assert.equal((await deliverFunnelQuickBooks({db:{rpc:async()=>({data:{status}})},job,key:'key',
      processRequest:()=>assert.fail('must not repeat')})).status,status);
  }
  await assert.rejects(deliverFunnelQuickBooks({db:{rpc:async()=>({data:{status:'pending',requestId:'same'}})},job,key:'key',
    processRequest:async()=>{throw new Error('transport unavailable');}}),/transport/);
});
test('unverified handoff and queue-only success cannot claim delivery',async()=>{
  await assert.rejects(deliverFunnelQuickBooks({db:{rpc:async()=>({data:{status:'complete-but-unverified'}})},job,key:'key'}),/requires retry/);
  const result=await deliverFunnelQuickBooks({db:{rpc:async()=>({data:{status:'pending',requestId:'same'}})},job,key:'key',
    processRequest:async()=>({state:'complete'})});
  assert.equal(result.status,'pending');
});
test('shared queue uses dedicated funnel guard/link authority and preserves ordinary source routing',async()=>{
  for(const source of ['booking','complex_event_booking','event_funnel']) {
    assert.equal(isAccountingEventSource(source),true);
    const calls=[],prefix=source==='event_funnel'?'event_funnel_quickbooks_':'accounting_event_';
    const db={rpc:async(name,args)=>{calls.push([name,args]);return {data:name.endsWith('guard')?true:{linked:true}};}};
    const row={id:'request',lease_token:'token',source_type:source,provider:'quickbooks'};
    await assertAccountingEventSource({db,row});await linkAccountingEventSource({db,row});
    assert.deepEqual(calls.map(row=>row[0]),[`${prefix}guard`,`${prefix}link`]);
  }
  await assert.rejects(assertAccountingEventSource({row:{source_type:'event_funnel',provider:'quickbooks'},
    db:{rpc:async()=>({data:false})}}),{code:'ACCOUNTING_EVENT_SOURCE_CHANGED'});
});
